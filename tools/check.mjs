#!/usr/bin/env node
// 리포 관리자용 검사기. 학습자에게는 필요 없다.
// 검사: 커리큘럼 형식·선수 관계(R2), 국내 근거·글로벌 비교 칸(R10), 「」 이름과 출처 표 대조·변하는 수치 금지(R11),
// 미리 만든 시각 자료 없음(R5), 설정 JSON 유효성.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const read = (p) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");

const LEVELS = ["Explain", "Apply", "Evaluate", "Develop"];
const FIELDS = ["유형", "선수", "핵심 질문", "목표", "만들어 볼 것", "국내 근거", "글로벌 비교", "근거"];
const TYPES = ["제도", "원리"];

function parseCurriculum(text) {
  const modules = new Map();
  const problems = [];
  const [body, sourcePart = ""] = text.split(/^## 출처 표$/m);
  if (!sourcePart) problems.push("「## 출처 표」 절 없음");
  const sources = new Set();
  let inTable = true;
  if (/^### /m.test(sourcePart)) problems.push("출처 표 뒤에 모듈이 있음");
  for (const line of sourcePart.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (!line.startsWith("|")) { if (sources.size) inTable = false; continue; }
    if (!inTable) { problems.push(`출처 표 밖의 표 줄: ${line.slice(0, 40)}`); continue; }
    if (cells[1] === "이름" || /^-+$/.test(cells[1])) continue;
    if (cells.length !== 6) { problems.push(`출처 표 칸 수 오류: ${line.slice(0, 40)}`); continue; }
    const [, name, org, url, date] = cells;
    if (!name || !org) problems.push(`출처 표 빈 칸: ${line}`);
    if (!/^<?https:\/\/[^\s>]+>?$/.test(url) || url === "<https://>") problems.push(`출처 표 URL 형식 오류: ${name}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) problems.push(`출처 표 조회일 형식 오류: ${name}`);
    sources.add(name);
  }
  if (sources.size === 0) problems.push("출처 표가 비어 있음");
  for (const m of text.matchAll(/제\s*\d+\s*조(의\s*\d+)?|\d+\s*조의\s*\d+/g)) problems.push(`지도에 조문 번호 금지: ${m[0]}`);
  const blocks = body.split(/^### /m).slice(1);
  for (const block of blocks) {
    const head = block.split("\n")[0];
    const m = head.match(/^([DPMGBX]\d+) · (.+)$/);
    if (!m) { problems.push(`모듈 제목 형식 오류: ${head}`); continue; }
    const id = m[1];
    if (modules.has(id)) problems.push(`${id}: 중복 id`);
    const fields = {};
    for (const line of block.split("\n").slice(1)) {
      const f = line.match(/^- ([^:]+): (.+)$/);
      if (f) fields[f[1]] = f[2].trim();
    }
    for (const name of FIELDS) if (!fields[name] || /^(-|없음|해당 없음|tbd|todo)$/i.test(fields[name]) && name !== "선수") problems.push(`${id}: 「${name}」 없음`);
    if (fields["유형"] && !TYPES.includes(fields["유형"])) problems.push(`${id}: 유형은 제도·원리 중 하나`);
    for (const f of Object.keys(fields).filter((k) => k !== "핵심 질문")) for (const n of (fields[f] || "").matchAll(/「([^」]+)」/g)) if (!sources.has(n[1])) problems.push(`${id}: 출처 표에 없는 이름 「${n[1]}」`);
    for (const f of ["국내 근거", "글로벌 비교"]) if (fields[f] && /\d\s*([%％]|퍼센트)/.test(fields[f])) problems.push(`${id}: ${f}에 수치 금지`);
    if (id.startsWith("X") && fields["목표"] && !fields["목표"].startsWith("Develop — ")) problems.push(`${id}: 졸업 프로젝트 목표는 Develop`);
    if (fields["목표"] && !LEVELS.some((l) => fields["목표"].startsWith(`${l} — `))) problems.push(`${id}: 목표 수준 형식 오류`);
    const prereq = !fields["선수"] || fields["선수"] === "없음" ? [] : fields["선수"].split(",").map((s) => s.trim());
    modules.set(id, prereq);
  }
  for (const [id, prereq] of modules) for (const p of prereq) if (!modules.has(p)) problems.push(`${id}: 없는 선수 ${p}`);
  const state = new Map();
  const visit = (id, path) => {
    if (state.get(id) === 2 || !modules.has(id)) return;
    if (state.get(id) === 1) { problems.push(`선수 순환: ${[...path, id].join(" → ")}`); return; }
    state.set(id, 1);
    for (const p of modules.get(id)) visit(p, [...path, id]);
    state.set(id, 2);
  };
  for (const id of modules.keys()) visit(id, []);
  return { modules, problems };
}

function findVisualAssets(files) {
  const allowedJs = /^tools\/.*\.m?js$/;
  return files.filter((f) => /\.(html?|css|svg|png|jpe?g|gif|webp|avif)$/i.test(f) || (/\.m?js$/i.test(f) && !allowedJs.test(f)));
}

function findTemplateMarkup(name, text) {
  const hits = [];
  for (const m of text.matchAll(/(```|~~~)[\s\S]*?\1/g)) if (/<(!doctype|html|svg|style|canvas|script)\b/i.test(m[0])) hits.push(name);
  return hits;
}

function main() {
  const { modules, problems } = parseCurriculum(read("curriculum/map.md"));
  errors.push(...problems);
  if (modules.size === 0) errors.push("모듈을 찾지 못함");

  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const f of findVisualAssets(files)) errors.push(`미리 만든 시각 자료 금지: ${f}`);
  for (const f of files.filter((x) => x.endsWith(".md") && existsSync(join(root, x)))) for (const n of findTemplateMarkup(f, read(f))) errors.push(`복사용 마크업 금지: ${n}`);

  for (const p of [".claude/settings.json", "learner-template/state.json"]) {
    try { JSON.parse(read(p)); } catch (e) { errors.push(`${p}: JSON 오류 ${e.constructor.name}`); }
  }
  if (!existsSync(join(root, "learner-template/log.md"))) errors.push("learner-template/log.md 없음");
  for (const s of readdirSync(join(root, ".claude/skills"))) {
    if (statSync(join(root, ".claude/skills", s)).isDirectory() && !existsSync(join(root, ".claude/skills", s, "SKILL.md"))) errors.push(`스킬 ${s}: SKILL.md 없음`);
  }
  if (!read(".gitignore").split("\n").includes("learner/")) errors.push(".gitignore에 learner/ 없음");

  if (errors.length) { console.error(errors.map((e) => `FAIL ${e}`).join("\n")); process.exit(1); }
  console.log(`OK 모듈 ${modules.size}개, 파일 ${files.length}개 검사`);
}

main();
