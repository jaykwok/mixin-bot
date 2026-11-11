import { fileURLToPath } from "node:url";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import type { AgentModuleDefinition, DocumentTemplates } from "../../modules.ts";
import { documentWorkTools } from "./tools.ts";

/** Application-owned resources only; group material never participates in discovery. */
export function documentWorkModule(templates: DocumentTemplates = {}): AgentModuleDefinition {
  const skillRoot = fileURLToPath(new URL("./skills/document-work/", import.meta.url));
  const skills = loadSkills({ cwd: skillRoot, agentDir: skillRoot, skillPaths: [skillRoot], includeDefaults: false });
  if (skills.skills.length !== 1 || skills.diagnostics.length) {
    throw new Error("项目文档 skill 加载失败：" + JSON.stringify(skills.diagnostics));
  }
  const configured = [templates.pptx ? "PPT" : "", templates.docx ? "Word" : ""].filter(Boolean);
  return {
    name: "document-work", tools: documentWorkTools(templates), skills, readOnlyDirs: [skillRoot],
    // One point per line: which skill to read first, the four paths, where the tools can be called, how to look and
    // send. The details are in the skill.
    prompt: ["## 文档加工",
      "修改、选编 Word/PPT，或在资料与模板基础上生成新文档时，先读取项目提供的 document-work skill。",
      "- 四条路径：局改 document_patch；选编 document_compose；按模板用 Markdown 生成 document_build（compose 的 content 项相同，页内短段自动排成卡片、流程、分层架构、时间轴等图示）；看图检查 document_render。",
      "- 资料中的图用 document_images 提取后引用；带判断和回退的流程图在 Markdown 里写 ```mermaid 代码块。",
      "- 这六个文档工具只能在 codemode 脚本里调用（await tools.document_inspect({...})）。",
      "- 看图用 read（脚本里用 image(await tools.read({ path })) 显示）；登记和发送在脚本外：deliverable_register、send_file 脚本里没有。",
      "- 资料选择、结构与内容由你根据本次任务决定，排版交给工具。没有实际看图检查时不声称版式已通过。"].join("\n") +
      (configured.length ? `\n管理员已配置默认${configured.join("、")}模板：document_build 不传 template 时自动套用，结果的 build.defaultTemplate 说明是否实际使用；只有用户指定其他文件的样式时才传 template。` : ""),
  };
}
