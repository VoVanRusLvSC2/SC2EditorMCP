// Original declaration controls. No serialized graph replacement or model offsets.
struct TriggerDeclarationLayout {
  const wchar_t *kind = L"";
  int type = 0, first = 0, last = 0, initial = 0;
};
static TriggerDeclarationLayout TriggerDeclarationControls(HWND root) {
  TriggerDeclarationLayout result;
  for (const auto &candidate : std::vector<TriggerDeclarationLayout>{
        {L"variable", 320, 316, 345, 345}, {L"local", 600, 596, 625, 625},
        {L"parameter", 500, 496, 534, 534}, {L"return_type", 615, 615, 629, 0}}) {
    HWND control = Control(root, candidate.type, L"ComboBox");
    if (control && IsWindowVisible(control)) {
      if (result.type) return {};
      result = candidate;
    }
  }
  return result;
}
static std::wstring TriggerDeclarationSnapshot(HWND root, bool json) {
  HWND left = Control(root, 28, L"SysTreeView32");
  auto selection = left ? reinterpret_cast<HTREEITEM>(SendMessageW(left, TVM_GETNEXTITEM, TVGN_CARET, 0)) : nullptr;
  const auto tree = left ? ModuleTree(left) : ModuleTreeView{};
  const auto layout = TriggerDeclarationControls(root);
  const auto kind = std::wstring(layout.kind);
  if (tree.hash.empty() || !selection || !layout.type) return L"";
  const int first = layout.first, last = layout.last;
  std::wstring hash = tree.hash + L":" + std::to_wstring(reinterpret_cast<uintptr_t>(selection)), values = L"[";
  bool comma = false;
  for (HWND h : Children(root)) {
    int id = GetDlgCtrlID(h);
    const auto cls = Class(h);
    if (!IsWindowVisible(h) || id < first || id > last ||
        (cls != L"Edit" && cls != L"RichEdit20W" && cls != L"Button" && cls != L"ComboBox" && cls != L"SysTreeView32")) continue;
    auto text = Text(h);
    if (text.size() >= 4095) return L"";
    const auto checkState = cls == L"Button" ? SendMessageW(h, BM_GETCHECK, 0, 0) : 0;
    const bool checked = checkState == BST_CHECKED;
    const auto nested = cls == L"SysTreeView32" ? ModuleTree(h) : ModuleTreeView{};
    if (cls == L"SysTreeView32" && nested.hash.empty()) return L"";
    const bool enabled = IsWindowEnabled(h);
    hash += L"\x1e" + std::to_wstring(id) + L":" + cls + L":" + std::to_wstring(text.size()) + L"#" + text +
            L":" + std::to_wstring(checkState) + L":" + (enabled ? L"1" : L"0") + L":" + nested.hash;
    if (comma) values += L",";
    comma = true;
    values += L"{\"id\":" + std::to_wstring(id) + L",\"type\":" + Quote(cls) + L",\"text\":" + Quote(text) +
              L",\"enabled\":" + std::wstring(enabled ? L"true" : L"false") + L",\"checked\":" + (checked ? L"true" : L"false");
    if (cls == L"Button") values += L",\"checkState\":" + std::to_wstring(checkState) + L",\"buttonStyle\":" + std::to_wstring(GetWindowLongW(h, GWL_STYLE) & BS_TYPEMASK);
    if (cls == L"SysTreeView32") values += L",\"tree\":" + nested.json;
    if (cls == L"ComboBox") {
      auto count = SendMessageW(h, CB_GETCOUNT, 0, 0);
      if (count < 0 || count > 256) return L"";
      values += L",\"options\":[";
      for (int i = 0; i < count; i++) {
        auto length = SendMessageW(h, CB_GETLBTEXTLEN, i, 0);
        if (length < 0 || length > 511) return L"";
        wchar_t label[512]{};
        SendMessageW(h, CB_GETLBTEXT, i, reinterpret_cast<LPARAM>(label));
        if (i) values += L",";
        values += Quote(label);
      }
      values += L"]";
    }
    values += L"}";
  }
  HWND detail = TriggerControlTree(root, 134);
  if (kind != L"variable") {
    const auto snapshot = detail ? ModuleTree(detail) : ModuleTreeView{};
    if (snapshot.hash.empty()) return L"";
    auto item = reinterpret_cast<HTREEITEM>(SendMessageW(detail, TVM_GETNEXTITEM, TVGN_CARET, 0));
    const auto rows = TriggerGraphRows(detail);
    auto found = std::find_if(rows.begin(), rows.end(), [&](const TriggerGraphRow &r) { return r.handle == item; });
    if (found == rows.end()) return L"";
    if (kind == L"return_type") { if (found->text.rfind(L"Return Type:", 0) != 0) return L""; }
    else if (found->parent < 0 || rows[found->parent].text != (kind == L"local" ? L"Local Variables" : L"Parameters")) return L"";
    hash += L":" + snapshot.hash + L":" + std::to_wstring(reinterpret_cast<uintptr_t>(item));
  }
  const auto fingerprint = PlacementHash(hash);
  return json ? L"{\"fingerprint\":" + Quote(fingerprint) + L",\"kind\":" + Quote(layout.kind) +
                L",\"treeFingerprint\":" + Quote(tree.hash) + L",\"controls\":" + values + L"],\"mapMutation\":false}" : fingerprint;
}
static void TriggerDeclarationExecute(LiveDataRequest *b, HWND root) {
  HWND tree = Control(root, 28, L"SysTreeView32");
  const auto snapshot = tree ? ModuleTree(tree) : ModuleTreeView{};
  if (Text(root).rfind(L"Triggers - [", 0) != 0 || !tree || snapshot.hash.empty() ||
      SendMessageW(tree, TVM_GETEDITCONTROL, 0, 0)) {
    Fail(b, L"LIVE_TRIGGER_DECLARATION_CONTEXT_REQUIRED");
    return;
  }
  if (std::wstring(b->field) == L"preflight") {
    if (TriggerPendingUserInput(root)) {
      Fail(b, L"LIVE_TRIGGER_DECLARATION_MANUAL_BUFFER_PRESERVED"); return;
    }
    Result(b, L"{\"ready\":true,\"mapMutation\":false}"); return;
  }
  auto selected = reinterpret_cast<HTREEITEM>(SendMessageW(tree, TVM_GETNEXTITEM, TVGN_CARET, 0));
  const auto rows = TriggerGraphRows(tree);
  auto row = std::find_if(rows.begin(), rows.end(), [&](const TriggerGraphRow &r) {
    return r.handle == selected && std::to_wstring(reinterpret_cast<uintptr_t>(r.handle)) == b->unit;
  });
  if (row == rows.end() || !TriggerGraphSingleSelection(tree)) {
    Fail(b, L"LIVE_TRIGGER_DECLARATION_SELECTION_CHANGED");
    return;
  }
  const auto field = std::wstring(b->field);
  if (field == L"read") {
    const auto value = TriggerDeclarationSnapshot(root, true);
    if (value.empty()) Fail(b, L"LIVE_TRIGGER_DECLARATION_PANEL_UNAVAILABLE");
    else Result(b, value);
    return;
  }
  if (field == L"create") {
    for (int id : {320, 134, 154}) {
      HWND panel = Control(root, id, id == 320 ? L"ComboBox" : L"SysTreeView32");
      if (panel && IsWindowVisible(panel)) {
        Fail(b, L"LIVE_TRIGGER_DECLARATION_PARENT_CONTAINER_REQUIRED"); return;
      }
    }
    const auto kind = std::wstring(b->value);
    const wchar_t *command = kind == L"variable" ? L"New Variable"
                            : kind == L"function" ? L"New Function"
                            : kind == L"action_definition" ? L"New Action Definition"
                            : kind == L"trigger" ? L"New Trigger"
                            : nullptr;
    const auto name = std::wstring(b->token);
    if (!command || b->expected != snapshot.hash || name.empty() || name.size() > 63 ||
        std::any_of(name.begin(), name.end(), [](wchar_t c) { return c < 32 || c == L'*'; })) {
      Fail(b, L"LIVE_TRIGGER_DECLARATION_CREATE_CHANGED");
      return;
    }
    SetActiveWindow(root);
    SetFocus(tree);
    if (GetFocus() != tree || !Invoke(root, command)) {
      Fail(b, L"LIVE_TRIGGER_DECLARATION_CREATE_UNAVAILABLE");
      return;
    }
    // A newly created element starts the original inline name editor. Commit
    // only that new selection; a lost acknowledgement must never recreate it.
    HWND edit = reinterpret_cast<HWND>(SendMessageW(tree, TVM_GETEDITCONTROL, 0, 0));
    auto created = reinterpret_cast<HTREEITEM>(SendMessageW(tree, TVM_GETNEXTITEM, TVGN_CARET, 0));
    const bool isNew = created && std::none_of(rows.begin(), rows.end(),
        [&](const TriggerGraphRow &r) { return r.handle == created; });
    bool named = false;
    if (isNew && edit && Class(edit) == L"Edit") {
      SendMessageW(edit, WM_SETTEXT, 0, reinterpret_cast<LPARAM>(name.c_str()));
      if (Text(edit) == name) {
        SendMessageW(tree, TVM_ENDEDITLABELNOW, FALSE, 0);
        named = true;
      }
    }
    Result(b, L"{\"submitted\":true,\"nameSubmitted\":" + std::wstring(named ? L"true" : L"false") +
                  L",\"retryMutation\":false}");
    return;
  }
  const auto fingerprint = TriggerDeclarationSnapshot(root, false);
  if (fingerprint.empty() || fingerprint != b->expected) {
    Fail(b, L"LIVE_TRIGGER_DECLARATION_CHANGED");
    return;
  }
  const auto layout = TriggerDeclarationControls(root);
  if (field == L"option") {
    HWND options = std::wstring(layout.kind) == L"parameter" ? Control(root, 526, L"SysTreeView32") : nullptr;
    const auto rows = options ? TriggerGraphRows(options) : std::vector<TriggerGraphRow>{};
    HTREEITEM match = nullptr;
    for (const auto &r : rows) if (r.text == b->value) { if (match) { Fail(b, L"LIVE_TRIGGER_PARAMETER_OPTION_AMBIGUOUS"); return; } match = r.handle; }
    const auto requested = std::wstring(b->token);
    if (!options || !IsWindowVisible(options) || !IsWindowEnabled(options) || !match ||
        (requested != L"true" && requested != L"false")) { Fail(b, L"LIVE_TRIGGER_PARAMETER_OPTION_UNAVAILABLE"); return; }
    auto state = (SendMessageW(options, TVM_GETITEMSTATE, reinterpret_cast<WPARAM>(match), TVIS_STATEIMAGEMASK) & TVIS_STATEIMAGEMASK) >> 12;
    if (state != 1 && state != 2) { Fail(b, L"LIVE_TRIGGER_PARAMETER_OPTION_STATE_UNSUPPORTED"); return; }
    if ((state == 2) == (requested == L"true")) { Result(b, L"{\"unchanged\":true}"); return; }
    SetActiveWindow(root); SetFocus(options);
    SendMessageW(options, TVM_SELECTITEM, TVGN_CARET, reinterpret_cast<LPARAM>(match));
    if (GetFocus() != options || !TriggerGraphSingleSelection(options)) { Fail(b, L"LIVE_TRIGGER_PARAMETER_OPTION_SELECTION_CHANGED"); return; }
    PostMessageW(options, WM_KEYDOWN, VK_SPACE, 0); PostMessageW(options, WM_KEYUP, VK_SPACE, 0);
    Result(b, L"{\"submitted\":true,\"retryMutation\":false}"); return;
  }
  int offset = field == L"type" ? 0 : field == L"subtype" ? 1 : field == L"constant" ? 5
              : field == L"array" ? 6 : field == L"dimensions" ? 8 : field == L"size" ? 12
              : field == L"default_enabled" && std::wstring(layout.kind) == L"parameter" ? 31 : -1;
  int id = offset < 0 ? 0 : layout.type + offset;
  HWND control = id ? GetDlgItem(GetParent(Control(root, layout.type, L"ComboBox")), id) : nullptr;
  // Resolve through the bounded module rather than trusting a caller's HWND.
  if (!control || !IsWindowVisible(control) || !IsWindowEnabled(control)) {
    Fail(b, L"LIVE_TRIGGER_DECLARATION_FIELD_UNAVAILABLE"); return;
  }
  auto requested = std::wstring(b->value), cls = Class(control);
  if (cls == L"ComboBox") {
    auto count = SendMessageW(control, CB_GETCOUNT, 0, 0);
    int match = -1;
    if (count < 0 || count > 256) { Fail(b, L"LIVE_TRIGGER_DECLARATION_OPTIONS_BOUND"); return; }
    for (int i = 0; i < count; i++) {
      auto length = SendMessageW(control, CB_GETLBTEXTLEN, i, 0);
      if (length < 0 || length > 511) { Fail(b, L"LIVE_TRIGGER_DECLARATION_OPTIONS_BOUND"); return; }
      wchar_t label[512]{}; SendMessageW(control, CB_GETLBTEXT, i, reinterpret_cast<LPARAM>(label));
      if (label == requested) { if (match >= 0) { Fail(b, L"LIVE_TRIGGER_DECLARATION_OPTION_AMBIGUOUS"); return; } match = i; }
    }
    if (match < 0 || requested.empty()) { Fail(b, L"LIVE_TRIGGER_DECLARATION_OPTION_NOT_FOUND"); return; }
    SendMessageW(control, CB_SETCURSEL, match, 0);
    PostMessageW(GetParent(control), WM_COMMAND, MAKEWPARAM(id, CBN_SELCHANGE), reinterpret_cast<LPARAM>(control));
  } else if (cls == L"Button" && (field == L"array" || field == L"constant" || field == L"default_enabled")) {
    const auto style = GetWindowLongW(control, GWL_STYLE) & BS_TYPEMASK;
    if (style != BS_CHECKBOX && style != BS_AUTOCHECKBOX && style != BS_3STATE && style != BS_AUTO3STATE) { Fail(b, L"LIVE_TRIGGER_DECLARATION_CHECKBOX_REQUIRED"); return; }
    if (requested != L"true" && requested != L"false") { Fail(b, L"LIVE_TRIGGER_DECLARATION_BOOLEAN_REQUIRED"); return; }
    const auto desired = requested == L"true" ? BST_CHECKED : BST_UNCHECKED;
    if (SendMessageW(control, BM_GETCHECK, 0, 0) == desired) { Result(b, L"{\"unchanged\":true}"); return; }
    // SC2 uses AUTO3STATE even for ordinary declaration flags. A click from
    // true would pass through indeterminate, not explicit false. Set the native
    // control state and notify its original handler exactly once.
    SendMessageW(control, BM_SETCHECK, desired, 0);
    PostMessageW(GetParent(control), WM_COMMAND, MAKEWPARAM(id, BN_CLICKED), reinterpret_cast<LPARAM>(control));
  } else if (cls == L"Edit" && field == L"size") {
    wchar_t *end = nullptr;
    long size = wcstol(requested.c_str(), &end, 10);
    if (requested.empty() || !end || *end || size < 1 || size > 8192) { Fail(b, L"LIVE_TRIGGER_DECLARATION_SIZE_BOUND"); return; }
    SendMessageW(control, WM_SETTEXT, 0, reinterpret_cast<LPARAM>(requested.c_str()));
    PostMessageW(GetParent(control), WM_COMMAND, MAKEWPARAM(id, EN_KILLFOCUS), reinterpret_cast<LPARAM>(control));
  } else { Fail(b, L"LIVE_TRIGGER_DECLARATION_FIELD_UNSUPPORTED"); return; }
  Result(b, L"{\"submitted\":true,\"retryMutation\":false}");
  return;
}
