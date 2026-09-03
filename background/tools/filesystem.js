// background/tools/filesystem.js — 工作区文件系统 / Workspace filesystem over OPFS
// 说明：扩展无法读写用户任意路径（无 Node fs），用 Origin Private File System 实现一个
// 私有的「工作区」/ Private workspace: read/write/list/mkdir/remove/search over OPFS.
import { defineTool } from './registry.js';

async function rootDir() {
  return await navigator.storage.getDirectory();
}

// 解析 path → { dir, name }（dir = 父目录 handle，name = 最后一段）
async function resolvePath(dir, path) {
  const parts = String(path || '').split('/').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { dir, name: '' };
  const name = parts.pop();
  let cur = dir;
  for (const p of parts) cur = await cur.getDirectoryHandle(p);
  return { dir: cur, name };
}

async function readText(handle) {
  const file = await handle.getFile();
  return await file.text();
}

async function writeText(handle, content) {
  const w = await handle.createWritable();
  await w.write(content);
  await w.close();
}

async function listEntries(dir) {
  const out = [];
  for await (const [name, handle] of dir.entries()) {
    out.push({ name, kind: handle.kind });
  }
  return out;
}

// 递归搜索（文件名 + 文本文件内容，限制深度与文件大小）
async function search(dir, query, prefix, results, depth) {
  if (depth > 10 || results.length >= 200) return;
  for await (const [name, handle] of dir.entries()) {
    const full = prefix ? prefix + '/' + name : name;
    if (handle.kind === 'directory') {
      if (name.toLowerCase().includes(query)) results.push({ path: full, kind: 'directory' });
      await search(handle, query, full, results, depth + 1);
    } else {
      let hit = name.toLowerCase().includes(query);
      if (!hit) {
        try {
          const file = await handle.getFile();
          if (file.size < 512 * 1024) {
            const text = await file.text();
            if (text.toLowerCase().includes(query)) hit = true;
          }
        } catch {}
      }
      if (hit) results.push({ path: full, kind: 'file' });
    }
  }
}

defineTool({
  name: 'fs_write_file',
  description: 'Write content to a file in the workspace (create or overwrite). Path is relative to the workspace root, e.g. "notes/todo.md".',
  parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  execute: async ({ path, content }) => {
    const root = await rootDir();
    const { dir, name } = await resolvePath(root, path);
    if (!name) return { error: '非法路径：' + path };
    const handle = await dir.getFileHandle(name, { create: true });
    await writeText(handle, String(content));
    return { ok: true, path };
  },
});

defineTool({
  name: 'fs_read_file',
  description: 'Read the content of a file in the workspace.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  execute: async ({ path }) => {
    const root = await rootDir();
    const { dir, name } = await resolvePath(root, path);
    if (!name) return { error: '非法路径：' + path };
    try {
      const handle = await dir.getFileHandle(name);
      return { ok: true, path, content: await readText(handle) };
    } catch (e) {
      return { error: '文件不存在：' + path };
    }
  },
});

defineTool({
  name: 'fs_list_dir',
  description: 'List files and directories in a workspace directory (empty path = root).',
  parameters: { type: 'object', properties: { path: { type: 'string', description: 'directory path, default root' } } },
  execute: async ({ path }) => {
    const root = await rootDir();
    const { dir } = await resolvePath(root, path || '');
    return { ok: true, path: path || '/', entries: await listEntries(dir) };
  },
});

defineTool({
  name: 'fs_mkdir',
  description: 'Create a directory in the workspace (recursive).',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  execute: async ({ path }) => {
    const root = await rootDir();
    const parts = String(path).split('/').map((s) => s.trim()).filter(Boolean);
    let cur = root;
    for (const p of parts) cur = await cur.getDirectoryHandle(p, { create: true });
    return { ok: true, path };
  },
});

defineTool({
  name: 'fs_remove',
  description: 'Remove a file or directory from the workspace (recursive).',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  execute: async ({ path }) => {
    const root = await rootDir();
    const { dir, name } = await resolvePath(root, path);
    if (!name) return { error: '非法路径：' + path };
    try {
      await dir.removeEntry(name, { recursive: true });
      return { ok: true, path };
    } catch (e) {
      return { error: '删除失败：' + path };
    }
  },
});

defineTool({
  name: 'fs_search',
  description: 'Search the workspace by filename or text-file content (case-insensitive). Returns matching paths.',
  parameters: { type: 'object', properties: { query: { type: 'string', description: 'search term' } }, required: ['query'] },
  execute: async ({ query }) => {
    const q = String(query).toLowerCase();
    const root = await rootDir();
    const results = [];
    await search(root, q, '', results, 0);
    return { ok: true, query, count: results.length, results };
  },
});
