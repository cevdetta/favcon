// Head injection.
//
// Astro has no official head-injection hook: all four injectScript stages are JavaScript,
// and a <link rel="icon"> written by a script is a link the browser finds late, after it has
// already asked for /favicon.ico. So the HTML is spliced instead, in an order:'post'
// middleware that runs once the page has rendered.
//
// Two guards. A page that already declares an icon is left alone: the author has said what
// they want, and two competing <link rel="icon"> sets is a coin toss. And only text/html is
// touched: an endpoint returning JSON is not a page.
//
// Splicing means buffering the page, which gives up streaming for HTML routes. That is the
// cost of putting the tags where the browser looks for them rather than where a script can
// reach; `head: 'component'` avoids the cost in full by letting you place <Head /> yourself.

import { links } from 'virtual:favcon';

import { declaresIcon } from '../lib/core.mjs';

export const onRequest = async (context, next) => {
  const response = await next();

  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('text/html')) return response;

  const html = await response.text();
  if (declaresIcon(html) || !html.includes('</head>')) {
    return new Response(html, response);
  }

  const patched = html.replace('</head>', `${links}</head>`);
  const headers = new Headers(response.headers);
  // The body has changed length, and a stale content-length truncates the page.
  headers.delete('content-length');
  return new Response(patched, { status: response.status, statusText: response.statusText, headers });
};
