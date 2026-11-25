// Each tab keeps the version it actually loaded. The server rejects stale writes.
const revisions = new Map();
export const characterChatKey = (avatar, name) => JSON.stringify(['character', avatar, name]);
export const groupChatKey = id => JSON.stringify(['group', String(id)]);
export function revisionHeaders(key, headers) { return { ...headers, 'X-Chat-Revision': revisions.get(key) || 'new' }; }
export function rememberChatRevision(key, response) {
    const revision = response.headers.get('X-Chat-Revision');
    if (response.ok && revision) revisions.set(key, revision);
}
