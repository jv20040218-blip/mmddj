# 明日方舟剧情数据插件（ark-story）

SillyTavern 扩展。只负责让角色卡里的剧情脚本取到 56 MB 原文库，不提供界面。

## 安装（三选一）

**1. 酒馆内安装（推荐）**

扩展 → 安装扩展 → 粘贴本仓库地址：

```
https://github.com/jv20040218-blip/mmddj
```

装好后重启酒馆，控制台应出现：

```
[ARK_STORY] 插件就绪：数据 56.2 MB，数据版本 318ad68d8d40，构建 4025ed25b4bc
```

**2. 手动复制**

把本仓库整个文件夹放到：

```
SillyTavern/data/default-user/extensions/ark-story
```

（ST 1.19 扫描用户级目录；老版本用 `public/scripts/extensions/third-party/ark-story`。）

**3. 一键脚本**

在酒馆控制台执行（需酒馆助手）：

```js
TavernHelper.installExtension('https://github.com/jv20040218-blip/mmddj')
```

## 数据校验

| 项 | 值 |
|---|---|
| 数据版本 | `318ad68d8d40` |
| 构建标识 | `4025ed25b4bc` |
| 字节数 | 58,862,512 |
| SHA-256 | `31dae4a49fc010a2aeb3472cccf382e1416ed68838c975905841019ee941b3ea` |
| 原文库节点 / 角色线 | 4,370 / 849 |

## 版本

`1.0.0` · 明日方舟剧情模块

数据版本必须与角色卡一致，否则剧情页能打开但节点会错位。
