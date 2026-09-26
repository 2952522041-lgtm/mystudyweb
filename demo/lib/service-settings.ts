/** All three providers append /chat/completions to this base URL. */
export function validateServiceBaseUrl(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return '请输入有效的 HTTP(S) 接口地址。'; }
  if (!['http:', 'https:'].includes(url.protocol)) return '请输入有效的 HTTP(S) 接口地址。';
  if (value !== value.trim()) return '接口地址首尾不能包含空格，请删除后重试。';
  if (/\/(?:chat\/completions|responses)\/?$/i.test(url.pathname)) {
    return '请填写接口基础地址（例如 https://api.example.com/v1），不要包含 /chat/completions 或 /responses；程序会自动追加请求路径。';
  }
  if (url.search || url.hash || url.username || url.password) return '接口基础地址不能包含查询参数、锚点或用户名密码；API Key 请填写在独立字段。';
  return null;
}
