import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const MAX_BYTES = 100_000;
const EXTENSIONS = new Set([".md", ".txt", ".json", ".html", ".css", ".js", ".mjs", ".ts", ".tsx", ".jsx", ".svg", ".csv", ".py", ".toml", ".yaml", ".yml"]);

// Reject symlinks throughout our managed tree. Native execution still uses OpenClaw's own sandbox/approval policy.
export async function safePath(workspace: string, relative: string, createParents = false): Promise<string> {
  const root = await fs.realpath(workspace);
  const parts = relative.split(/[\\/]/);
  if (path.isAbsolute(relative) || parts.some(p => !p || p === "." || p === ".." || p.includes("\0"))) throw new Error("Invalid relative project path");
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error("Symbolic links are not allowed in creations");
      if (i < parts.length - 1 && !stat.isDirectory()) throw new Error("Parent is not a directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (i < parts.length - 1 && createParents) await fs.mkdir(current);
      else if (i < parts.length - 1) throw error;
    }
  }
  return current;
}

export async function writeManaged(workspace:string,relative:string,content:string,overwrite=false) {
  if (Buffer.byteLength(content)>MAX_BYTES) throw new Error("Content too large");
  const target=await safePath(workspace,relative,true);
  const flags=constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (overwrite ? constants.O_TRUNC : constants.O_EXCL);
  let file;
  try {file=await fs.open(target,flags,0o600);} catch(error) {
    if((error as NodeJS.ErrnoException).code==="EEXIST") throw new Error(`${relative} already exists; use overwrite:true deliberately`);
    throw error;
  }
  try {await file.writeFile(content,"utf8");} finally {await file.close();}
  return {path:target,bytes:Buffer.byteLength(content)};
}

export type ProjectInput = {action:"list"|"read"|"write";project:string;path?:string;content?:string;overwrite?:boolean};
export async function projectAction(workspace:string,input:ProjectInput) {
  if(!/^[a-z0-9][a-z0-9_-]{0,80}$/.test(input.project)) throw new Error("project must be a lowercase slug");
  const base=`creations/projects/${input.project}`;
  if(input.action==="list") {
    // Listing also establishes a persistent project directory on first use.
    const probe=await safePath(workspace,`${base}/.probe`,true);
    const directory=path.dirname(probe);
    const entries=await fs.readdir(directory,{withFileTypes:true});
    return {path:directory,entries:entries.filter(item=>!item.isSymbolicLink()).slice(0,100).map(item=>({name:item.name,directory:item.isDirectory()}))};
  }
  if(!input.path || !EXTENSIONS.has(path.extname(input.path).toLowerCase())) throw new Error("Provide a supported text/code file path");
  const relative=`${base}/${input.path}`;
  if(input.action==="write") {
    if(typeof input.content!=="string") throw new Error("content is required");
    return writeManaged(workspace,relative,input.content,input.overwrite);
  }
  if(input.action!=="read") throw new Error("Unknown project action");
  const target=await safePath(workspace,relative);
  const file=await fs.open(target,constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat=await file.stat();
    if(!stat.isFile() || stat.size>MAX_BYTES) throw new Error("Not a bounded text file");
    return {path:target,content:await file.readFile("utf8"),bytes:stat.size};
  } finally {await file.close();}
}
