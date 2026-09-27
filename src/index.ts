import { handleAdmin } from './admin';
import { json } from './lib/http';
import { runMaintenance } from './maintenance';
import { handleSubmission } from './submit';

const SUBMISSION_PATH = /^\/api\/forms\/([a-z0-9][a-z0-9-]{1,62})\/submissions\/?$/;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    try {
      const submission = SUBMISSION_PATH.exec(url.pathname);
      if (submission) return await handleSubmission(request, env, ctx, submission[1]);

      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return await handleAdmin(request, env, url);
      if (url.pathname === '/') return Response.redirect(`${url.origin}/admin`, 302);
      if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
      if (url.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain' } });

      return json({ ok: false, error: 'Not found' }, { status: 404 });
    } catch (error) {
      console.error(JSON.stringify({ event: 'unhandled', path: url.pathname, error: String(error) }));
      return json({ ok: false, error: 'Something went wrong' }, { status: 500 });
    }
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(runMaintenance(env));
  },
} satisfies ExportedHandler<Env>;
