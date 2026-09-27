// Admin UI files are bundled as text (see "rules" in wrangler.jsonc).
declare module '*.html' {
  const content: string;
  export default content;
}
declare module '*.css' {
  const content: string;
  export default content;
}
declare module '*.client.js' {
  const content: string;
  export default content;
}
