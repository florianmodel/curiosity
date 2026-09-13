import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {afterEach,expect,it} from "vitest";
import {projectAction} from "./project.js";
import {NoteWriter} from "./notewrite.js";
const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(dir=>fs.rm(dir,{recursive:true,force:true})));});
async function root(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),"curiosity-project-"));dirs.push(dir);return dir;}
it("keeps editable nested project files and refuses silent overwrite",async()=>{
  const dir=await root();await projectAction(dir,{action:"write",project:"garden",path:"src/main.js",content:"console.log(1)"});
  const read=await projectAction(dir,{action:"read",project:"garden",path:"src/main.js"});expect(read).toHaveProperty("content","console.log(1)");
  await expect(projectAction(dir,{action:"write",project:"garden",path:"src/main.js",content:"oops"})).rejects.toThrow(/already exists/);
  await projectAction(dir,{action:"write",project:"garden",path:"src/main.js",content:"console.log(2)",overwrite:true});
  expect(await projectAction(dir,{action:"list",project:"garden"})).toHaveProperty("entries",[{name:"src",directory:true}]);
});
it("rejects traversal and symbolic-link parents for notes and projects",async()=>{
  const dir=await root();const elsewhere=await root();
  await fs.symlink(elsewhere,path.join(dir,"creations"));
  await expect(new NoteWriter(dir).write({slug:"escape",content:"x"})).rejects.toThrow(/Symbolic/);
  await expect(projectAction(dir,{action:"write",project:"escape",path:"x.js",content:"x"})).rejects.toThrow(/Symbolic/);
  expect(await fs.readdir(elsewhere)).toEqual([]);
  const clean=await root();await expect(projectAction(clean,{action:"write",project:"x",path:"../../oops.js",content:"x"})).rejects.toThrow(/Invalid/);
});
it("rejects symlink files and bounded read violations",async()=>{
  const dir=await root();await projectAction(dir,{action:"list",project:"x"});
  const outside=await root();await fs.writeFile(path.join(outside,"data.txt"),"private");
  await fs.symlink(path.join(outside,"data.txt"),path.join(dir,"creations/projects/x/link.txt"));
  await expect(projectAction(dir,{action:"read",project:"x",path:"link.txt"})).rejects.toThrow(/Symbolic/);
  await fs.writeFile(path.join(dir,"creations/projects/x/large.txt"),"x".repeat(100_001));
  await expect(projectAction(dir,{action:"read",project:"x",path:"large.txt"})).rejects.toThrow(/bounded/);
});
