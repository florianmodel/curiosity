import { writeManaged } from "./project.js";
import path from "node:path";

const MAX_CONTENT = 100_000;
const ALLOWED_EXTENSIONS = new Set(["md", "txt", "json", "html", "css", "js", "ts", "svg", "csv"]);

export type NoteInput = {
  slug: string;
  title?: string;
  content: string;
  extension?: string;
  overwrite?: boolean;
};

export class NoteWriter {
  constructor(readonly rootDir: string) {}

  async write(input: NoteInput): Promise<{ path: string; bytes: number }> {
    const slug = String(input.slug ?? "").trim().toLowerCase().replace(/\s+/g, "-");
    if (!/^[a-z0-9][a-z0-9-_]{0,80}$/.test(slug)) throw new Error(`Invalid slug "${slug}": use lowercase letters, digits, dashes`);
    const extension = String(input.extension ?? "md").toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error(`Extension .${extension} not allowed (allowed: ${[...ALLOWED_EXTENSIONS].join(", ")})`);
    const content = String(input.content ?? "");
    if (content.length === 0) throw new Error("Refusing to write empty content");
    if (content.length > MAX_CONTENT) throw new Error(`Content too large (${content.length} chars, max ${MAX_CONTENT})`);

    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const dir = path.join(this.rootDir, "creations", month);
    const target = path.join(dir, `${slug}.${extension}`);
    if (!target.startsWith(path.join(this.rootDir, "creations") + path.sep)) throw new Error("Path escaped the creations directory");

    const header = input.title && extension === "md" ? `# ${String(input.title).replace(/\n/g, " ").slice(0, 120)}\n\n` : "";
    return writeManaged(this.rootDir, `creations/${month}/${slug}.${extension}`, header + content, input.overwrite);
  }
}
