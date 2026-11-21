// The portable refresh path uses window/menu messages on one qualified Editor
// build. It never loads the memory adapter or silently confirms native dialogs.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

internal static partial class LiveEditor {
  private const string PortableRefreshVersion = "5.0.17.98745";
  private const string PortableRefreshSha256 = "c31f1ac714f237a0190179f5dbb49298c8e2dbcbda30008297a316b1b18394c4";
  private static string portableEditorPath;
  private static DateTime portableEditorTimestamp;
  private static long portableEditorSize;

  [DllImport("user32.dll")] private static extern uint GetMenuItemID(IntPtr menu, int index);
  [DllImport("user32.dll")] private static extern uint GetMenuState(IntPtr menu, uint item, uint flags);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr hwnd, EnumWindow callback, IntPtr arg);
  [DllImport("user32.dll", SetLastError=true)] private static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo data);
  [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr SendMessageTimeout(IntPtr hwnd,uint message,IntPtr wparam,IntPtr lparam,uint flags,uint ms,out UIntPtr value);

  [StructLayout(LayoutKind.Sequential)]
  private struct GuiThreadInfo {
    public uint size, flags;
    public IntPtr active, focus, capture, menuOwner, moveSize, caret;
    public int left, top, right, bottom;
  }

  private sealed class PortableRefreshState {
    public bool refreshReady, documentDirty, pendingInput;
    public bool mapMutation = false;
    public int openDocuments, pendingXmlBuffers;
    public string refreshFingerprint, backend = "portable_window_messages_98745";
    public List<object> dialogs = new List<object>();
  }

  private static string Digest(byte[] bytes) {
    return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
  }

  private static bool PortableRefreshEditor(Window window) {
    using (var process = Process.GetProcessById(window.processId)) {
      var file = new FileInfo(process.MainModule.FileName);
      if (FileVersionInfo.GetVersionInfo(file.FullName).FileVersion != PortableRefreshVersion) return false;
      if (file.FullName != portableEditorPath || file.LastWriteTimeUtc != portableEditorTimestamp || file.Length != portableEditorSize) {
        using (var source = File.OpenRead(file.FullName))
        using (var sha = SHA256.Create()) {
          if (Digest(sha.ComputeHash(source)) != PortableRefreshSha256)
            throw new Exception("LIVE_REFRESH_PORTABLE_BUILD_HASH_MISMATCH");
        }
        portableEditorPath = file.FullName;
        portableEditorTimestamp = file.LastWriteTimeUtc;
        portableEditorSize = file.Length;
      }
      return true;
    }
  }

  private static string PortableText(IntPtr hwnd) {
    var text = new StringBuilder(8192);
    GetWindowText(hwnd, text, text.Capacity);
    return text.ToString();
  }

  private static string PortableClass(IntPtr hwnd) {
    var kind = new StringBuilder(128);
    GetClassName(hwnd,kind,kind.Capacity);
    return kind.ToString();
  }

  private static IntPtr PortableMenu(IntPtr hwnd, string label) {
    var root = GetMenu(hwnd);
    IntPtr found = IntPtr.Zero;
    for (var i=0; i<GetMenuItemCount(root); ++i) {
      if (MenuLabel(root,i)!=label) continue;
      if (found!=IntPtr.Zero) throw new Exception("LIVE_REFRESH_MENU_AMBIGUOUS: "+label);
      found=GetSubMenu(root,i);
    }
    if (found==IntPtr.Zero) throw new Exception("LIVE_REFRESH_MENU_UNAVAILABLE: "+label);
    return found;
  }

  private static bool PortableMessage(IntPtr hwnd, uint message, out ulong value) {
    UIntPtr result;
    // Scintilla and edit control requests below return numeric values and take no pointers.
    bool ok = SendMessageTimeout(hwnd,message,IntPtr.Zero,IntPtr.Zero,0x22,250,out result)!=IntPtr.Zero;
    value=result.ToUInt64();
    return ok;
  }

  private static PortableRefreshState PortableInspect(IntPtr root, Window window) {
    var state=new PortableRefreshState();
    var matching=window.title.Substring(window.title.IndexOf('[')).Replace("*]","]");
    var fingerprint=new StringBuilder(window.title);
    state.refreshReady=window.enabled;
    var documents=OpenArchiveDocuments(root);
    state.openDocuments=documents.Count;
    foreach (var title in documents) fingerprint.Append('|').Append(title);

    var frames=new List<IntPtr>();
    EnumWindows(delegate(IntPtr hwnd,IntPtr arg) {
      uint pid; GetWindowThreadProcessId(hwnd,out pid);
      if (pid==window.processId) frames.Add(hwnd);
      return true;
    },IntPtr.Zero);
    frames.Sort(delegate(IntPtr left,IntPtr right) {return left.ToInt64().CompareTo(right.ToInt64());});
    foreach (var frame in frames) {
      var title=PortableText(frame);
      var owner=GetWindow(frame,4);
      if (IsWindowVisible(frame)&&PortableClass(frame)=="#32770"&&owner!=IntPtr.Zero&&!IsWindowEnabled(owner)) {
        state.dialogs.Add(new {handle=frame.ToInt64().ToString(),title=title,targetOwned=owner==root,controls=new object[0]});
        fingerprint.Append("|modal:").Append(frame.ToInt64()).Append(':').Append(title);
      }
      var bracket=title.IndexOf('[');
      if (bracket<0 || title.Substring(bracket).Replace("*]","]")!=matching) continue;
      fingerprint.Append('|').Append(frame.ToInt64()).Append(':').Append(title);
      state.refreshReady &= IsWindowEnabled(frame);
      state.documentDirty |= title.Contains("*]");
      uint pid;
      uint thread=GetWindowThreadProcessId(frame,out pid);
      var info=new GuiThreadInfo {size=(uint)Marshal.SizeOf(typeof(GuiThreadInfo))};
      if (thread==0 || !GetGUIThreadInfo(thread,ref info)) {
        state.refreshReady=false;
        continue;
      }
      EnumChildWindows(frame, delegate(IntPtr child,IntPtr arg) {
        var kind=PortableClass(child);
        ulong modified, readOnly;
        if (kind=="Scintilla") {
          if (!PortableMessage(child,2159,out modified) || !PortableMessage(child,2140,out readOnly)) {
            state.refreshReady=false;
            return true;
          }
          fingerprint.Append("|xml:").Append(child.ToInt64()).Append(':').Append(modified).Append(':').Append(readOnly);
          if (modified!=0 && readOnly==0) ++state.pendingXmlBuffers;
        } else if (child==info.focus && (kind=="Edit"||kind=="RichEdit20W")) {
          var editable=(GetWindowLongPtr(child,-16).ToInt64()&0x800)==0;
          if (!PortableMessage(child,0x00B8,out modified)) state.refreshReady=false;
          var parentId=GetWindowLongPtr(child,-12).ToInt64();
          if (editable && (modified!=0 || parentId==65535)) state.pendingInput=true;
          fingerprint.Append("|input:").Append(child.ToInt64()).Append(':').Append(modified);
        }
        return true;
      },IntPtr.Zero);
    }
    state.refreshReady &= !state.documentDirty && !state.pendingInput && state.pendingXmlBuffers==0
      && state.openDocuments==1 && state.dialogs.Count==0;
    using (var sha=SHA256.Create())
      state.refreshFingerprint=Digest(sha.ComputeHash(Encoding.UTF8.GetBytes(fingerprint.ToString())));
    return state;
  }

  private static object PortableRefreshCommand(IntPtr hwnd, Window window, uint operation, string expected, string token) {
    var inspected=PortableInspect(hwnd,window);
    if (operation==25) return inspected;
    if (String.IsNullOrWhiteSpace(token) || !inspected.refreshReady || expected!=inspected.refreshFingerprint)
      throw new Exception("LIVE_DOCUMENT_REFRESH_NOT_CLEAN");
    var file=PortableMenu(hwnd,"File");
    uint id=UInt32.MaxValue;
    for (var i=0; i<GetMenuItemCount(file); ++i) {
      if (MenuLabel(file,i)!="Close") continue;
      var candidate=GetMenuItemID(file,i);
      if (id!=UInt32.MaxValue || candidate==0 || candidate>65535 || (GetMenuState(file,(uint)i,0x400)&3)!=0)
        throw new Exception("LIVE_DOCUMENT_CLOSE_UNAVAILABLE");
      id=candidate;
    }
    var fresh=Read(hwnd);
    if (id==UInt32.MaxValue || fresh==null || !fresh.enabled || fresh.title!=window.title ||
        fresh.processId!=window.processId || fresh.processStart!=window.processStart ||
        !PostMessage(hwnd,0x0111,new IntPtr(id),IntPtr.Zero))
      throw new Exception("LIVE_DOCUMENT_CLOSE_UNAVAILABLE");
    return new {closeRequested=true,retryMutation=false,backend=inspected.backend,
      verification="same_process_empty_frame_and_released_file_required"};
  }
}
