'use strict';
// Facts live in the ledger; this renderer only controls presentation.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const docs = path.resolve(process.argv[2] || path.join(__dirname, '..', 'docs'));
const ledger = JSON.parse(fs.readFileSync(path.join(docs, '问题与修复台账.json'), 'utf8'));
const template = fs.readFileSync(path.join(docs, '总指导模板.md'), 'utf8');
const fail = message => { throw new Error(message); };
if (ledger.schema_version !== 1 || !Array.isArray(ledger.issues)) fail('Unsupported ledger');
const ids = new Set();
const required = ['id', 'area', 'kind', 'status', 'title', 'problem', 'fix', 'verification', 'caveat'];
for (const issue of ledger.issues) {
  for (const key of required) if (typeof issue[key] !== 'string' || !issue[key].trim()) fail(`${issue.id}: missing ${key}`);
  if (!/^B\d{3}$/.test(issue.id) || ids.has(issue.id)) fail(`Invalid/duplicate ID: ${issue.id}`);
  ids.add(issue.id);
  if (!issue.refs?.length || issue.refs.some(ref => !ledger.evidence_sources[ref])) fail(`Invalid evidence refs: ${issue.id}`);
}
const cell = value => String(value ?? '未记录').replaceAll('|', '\\|').replace(/\r?\n/g, '<br>');
const code = value => '`' + String(value) + '`';
const table = (headers, rows) => [headers, headers.map(() => '---'), ...rows].map(row => '| ' + row.map(cell).join(' | ') + ' |').join('\n');
const snapshot = ledger.snapshot;
const verification = snapshot.verification;
const counts = {};
for (const issue of ledger.issues) counts[issue.status] = (counts[issue.status] || 0) + 1;
const baseline = verification.inherited_runtime_verification || verification;
const currentTests = verification.ui_tests_total
  ? `${verification.ui_tests_passed}/${verification.ui_tests_total}项相关UI/结束回归；${verification.gate_passed}/${verification.gate_total}项成品检查`
  : `${verification.tests_passed}/${verification.tests_total}项测试；${verification.gate_passed}/${verification.gate_total}项成品检查`;
const snapshotRows = [
  ['运行时/不可变标签', `${snapshot.runtime_version} / v${snapshot.runtime_version}`],
  ['原插件仓库/main', snapshot.repository],
  ['运行时提交', code(snapshot.runtime_commit)],
  ['构建ID/剧情数据版本', `${code(snapshot.build_id)} / ${code(snapshot.data_version)}`],
  ['配套角色卡', `[下载${snapshot.runtime_version}角色卡](${snapshot.card.url})；${snapshot.card.bytes}字节`],
  ['角色卡SHA-256', code(snapshot.card.sha256)],
  ['内嵌脚本SHA-256', code(snapshot.script_sha256)],
  ['世界书', `${snapshot.worldbook}；${snapshot.worldbook_entries}条`],
  ['世界书内容版本', snapshot.worldbook_content_version || snapshot.runtime_version],
  ['剧情数据SHA-256', code(snapshot.data.sha256)],
  ['最后服务器保存选中头像', code(snapshot.selected_avatar)],
  ['服务器最后已核验卡版本（可早于发布版）', snapshot.selected_card_version_after_repair],
  ['本版服务器部署状态', snapshot.server_deployment || '见对应部署回执；不能用仓库版本代替实际服务器版本'],
  ['当前发布相关回归', currentTests],
  ['继承的1.7.0全量基线', `${baseline.tests_passed}项测试；${baseline.stories}篇/${baseline.routes}线/${baseline.scene_visits}次场景访问；${baseline.physical_switch_assertions}项物理开关断言`],
  ['部署目标选择回归', `${snapshot.target_selection_tests}项；独立于上述运行时测试`],
  ['独立条目覆盖', `${snapshot.actors_with_entries}个可匹配身份，其中${snapshot.multistate_actors}个多状态人物`],
  ['最近已核验部署保留项', '实际尾号头像、聊天指针、收藏、原聊天文件及现有世界书字节；无付费模型调用'],
  ['浏览器原失败动作与布局验收', '尚未取得；服务器落盘和DOM回归不能替代真实页面点击/几何证据'],
];
const open = ledger.issues.filter(issue => ['未关闭', '待核验', '已缓解'].includes(issue.status));
const areas = [...new Set(ledger.issues.map(issue => issue.area))];
const details = areas.map(area => '### ' + area + '\n\n' + ledger.issues.filter(issue => issue.area === area).map(issue => [
  `<a id="${issue.id.toLowerCase()}"></a>`,
  `#### ${issue.id} ${issue.title}`,
  `**类型：${issue.kind}｜状态：${issue.status}**`,
  `- 现象/原因：${issue.problem}\n- 修复/处置：${issue.fix}\n- 验证证据：${issue.verification}\n- 注意/剩余边界：${issue.caveat}\n- 来源：${issue.refs.join('、')}`,
].join('\n\n')).join('\n\n')).join('\n\n');
const replacements = {
  GUIDANCE_VERSION: ledger.guidance_version,
  AS_OF: ledger.as_of_date,
  SNAPSHOT: table(['项目', '事实快照'], snapshotRows),
  STATUS_COUNTS: `台账共**${ledger.issues.length}项**，按当前状态分类如下。\n\n` + table(['状态', '数量'], Object.entries(counts)) + '\n\n这些数量包含历史事故、功能修正、工程卡点和验收边界，不等于全部都是尚存程序bug。',
  OPEN_ITEMS: table(['ID', '状态', '事项', '下一步/限制'], open.map(issue => [`[${issue.id}](#${issue.id.toLowerCase()})`, issue.status, issue.title, issue.caveat])),
  VERSION_TABLE: table(['发布', '构建ID/数据版本', '世界书', '当时记录的验证', '运行时提交'], ledger.version_history.map(version => [
    version.version, `${code(version.build_id)} / ${code(version.data_version)}`, version.worldbook,
    version.verification_label || `${version.tests}项测试/${version.gate}项成品检查`, version.commit ? code(version.commit.slice(0, 12)) : '既有记录未列；不补造',
  ])),
  ISSUE_INDEX: table(['ID', '领域/类型', '状态', '标题'], ledger.issues.map(issue => [`[${issue.id}](#${issue.id.toLowerCase()})`, `${issue.area} / ${issue.kind}`, issue.status, issue.title])),
  ISSUE_DETAILS: details,
  EVIDENCE: table(['来源', '记录位置与证据性质'], Object.entries(ledger.evidence_sources)),
};
let output = template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => key in replacements ? replacements[key] : fail(`Unknown placeholder: ${key}`));
if (/\{\{[^}]+\}\}/.test(output)) fail('Unresolved placeholder');
// Check links generated here and relative links maintained in the template.
for (const [, fragment] of output.matchAll(/\]\(#(b\d{3})\)/g)) {
  if (!output.includes(`<a id="${fragment}"></a>`)) fail(`Missing anchor: ${fragment}`);
}
for (const [, target] of output.matchAll(/\]\(([^)\s]+\.md)\)/g)) {
  if (!target.includes('://') && !fs.existsSync(path.resolve(docs, target))) fail(`Missing relative link: ${target}`);
}
const sensitive = [/sk-[A-Za-z0-9_-]{20,}/, /\b(?:password|passwd)\s*[:=]\s*['"][^'"]{6,}/i, /https?:\/\/(?!127\.0\.0\.1[:/])\d+\.\d+\.\d+\.\d+/, /(?:面板密码|服务器密码|Basic密码)\s*[:：]\s*\S{6,}/];
if (sensitive.some(pattern => pattern.test(output))) fail('Sensitive deployment value in public guide');
output = output.replace(/\r\n/g, '\n').trimEnd() + '\n';
fs.writeFileSync(path.join(docs, '插件更新与角色卡交付协议.md'), output);
console.log(JSON.stringify({guidance: ledger.guidance_version, runtime: snapshot.runtime_version, issues: ids.size, statuses: counts, bytes: Buffer.byteLength(output), sha256: crypto.createHash('sha256').update(output).digest('hex'), validation: 'ledger-fields,unique-ids,evidence-refs,anchors,relative-links,placeholders,secret-patterns'}));
