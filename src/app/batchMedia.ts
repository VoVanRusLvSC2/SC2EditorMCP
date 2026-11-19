import type { BatchStep } from "./batchTypes.js";

const MAX_IMAGES = 4;
const MAX_IMAGE_BASE64_CHARACTERS = 700_000;
const MAX_BATCH_BASE64_CHARACTERS = 1_500_000;

type BatchImage = {
  type: "image";
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  data: string;
};
type BatchMedia = { type: "text"; text: string } | BatchImage;

/** Explicit opt-in media stays outside the compact JSON and has one shared response budget. */
export class BatchMediaCollector {
  readonly content: BatchMedia[] = [];
  included = 0;
  omitted = 0;
  private base64Characters = 0;
  collect(step: BatchStep, result: unknown) {
    if (step.args.includeImages !== true && step.args.includeImage !== true) return;
    const blocks = (result as { content?: unknown })?.content;
    if (!Array.isArray(blocks)) return;
    let label = "";
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") {
        label = block.text.startsWith("{") ? "" : block.text.slice(0, 200);
        continue;
      }
      if (block.type !== "image") continue;
      const data = block.data,
        mimeType = block.mimeType;
      if (
        typeof data !== "string" ||
        !["image/png", "image/jpeg", "image/webp"].includes(mimeType) ||
        data.length > MAX_IMAGE_BASE64_CHARACTERS ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(data) ||
        this.included >= MAX_IMAGES ||
        this.base64Characters + data.length > MAX_BATCH_BASE64_CHARACTERS
      ) {
        this.omitted++;
        continue;
      }
      this.content.push(
        { type: "text", text: `Step ${step.id} (${step.tool})${label ? ": " + label : ""}` },
        { type: "image", mimeType, data } as BatchImage,
      );
      this.included++;
      this.base64Characters += data.length;
      label = "";
    }
  }
  receipt() {
    return { included: this.included, omitted: this.omitted };
  }
}
