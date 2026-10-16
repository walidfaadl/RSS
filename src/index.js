/**
 * x-rss-worker — Cloudflare Worker يحوّل حسابات إكس (تويتر) وعمليات البحث إلى خلاصات RSS 2.0
 * مصدر البيانات: twitterapi.io (مفتاح API في المتغيّر السري TWITTERAPI_KEY)
 *
 * المسارات:
 *   GET /                         صفحة مساعدة + أداة لتوليد رابط الخلاصة
 *   GET /user/<username>          خلاصة حساب
 *   GET /search?q=<query>         خلاصة بحث (صيغة البحث المتقدم في إكس)
 *   GET /feed?url=<x.com link>    الصق رابط إكس مباشرة (حساب أو بحث)
 *   GET /opml                     ملف OPML لقائمة الحسابات في ACCOUNT_GROUPS أدناه
 *
 * خيارات (Query):
 *   replies=1    تضمين الردود (افتراضياً: لا)
 *   retweets=0   استبعاد إعادة التغريد (افتراضياً: تُضمَّن)
 *   key=...      مطلوب إذا ضُبط المتغيّر ACCESS_KEY
 *
 * أرشفة خلفية (للحسابات، وليس للبحث):
 *   مشغّل cron (انظر wrangler.toml) يسحب حساباً واحداً فقط كل دورة بالدور من
 *   ACCOUNT_GROUPS ويخزّن نتيجته في KV (TWEETS_KV). خلاصات /user و/feed للحساب
 *   تُقرأ من هذا المخزون مباشرة، فلا تصطدم أبداً بحد الـ5 ثوانٍ في twitterapi.io
 *   حتى لو طلب قارئ RSS عشرات الحسابات دفعة واحدة. حساب لم يُؤرشف بعد يُجلب حياً
 *   مرة واحدة ويُخزَّن تلقائياً ليصبح جاهزاً من المخزون في المرات القادمة.
 */

const API_BASE = "https://api.twitterapi.io";
const DEFAULT_TTL = 900; // ثوانٍ — كل طلب للـAPI مدفوع، لذا نخزّن مؤقتاً

// قائمة حسابات /opml — عدّلها وأعد النشر (npx wrangler deploy) لتحديث الملف
const ACCOUNT_GROUPS = [
  ["صحفيون", [
    ["باسل عدرا", "basel_adra"],
    ["مريم البرغوثي", "MariamBarghouti"],
    ["فادي قرآن", "fadiquran"],
  ]],
  ["غزة", [
    ["هند الخضري", "Hind_Gaza"],
    ["بليستيا العقاد", "PlestiaAlaqad"],
    ["مصعب أبو توها", "MosabAbuToha"],
    ["أحمد النعوق", "AhmedNaouq"],
    ["محمد شحادة", "muhammadshehad2"],
  ]],
  ["سياسيون وحقوقيون", [
    ["مصطفى البرغوثي", "MustafaBarghoti"],
    ["حنان عشراوي", "DrHananAshrawi"],
    ["ديانا بطو", "dianabuttu"],
    ["نورة عريقات", "4noura"],
  ]],
  ["الشتات", [
    ["علي أبونعمة", "AliAbunimah"],
    ["رمزي بارود", "RamzyBaroud"],
    ["سوزان أبو الهوى", "susanabulhawa"],
    ["طارق بقعوني", "tareqbaconi"],
    ["يارا هواري", "YaraHawari"],
  ]],
  ["معلّقون بالعربية", [
    ["ياسر الزعاترة", "YZaatreh"],
    ["تامر المسحال", "tameralmisshal"],
    ["نور عودة", "nour_odeh"],
  ]],
  ["محللون ومعلّقون سياسيون", [
    ["سعيد زياد", "saeedziad"],
    ["خالد صافي", "KhaledSafi"],
    ["أدهم أبو سلمية", "AdhamSelmiya"],
    ["إبراهيم المدهون", "eb78m"],
    ["مصطفى الصواف", "MostafaElsawaf"],
    ["د. فايز أبو شمالة", "FayezShamm18239"],
  ]],
  ["صحفيون ومراسلون ميدانيون", [
    ["وائل الدحدوح", "WaelDahdouh"],
    ["هشام زقوت", "hishamzaqout"],
    ["يوسف فارس", "Yusuf198989"],
    ["إسلام بدر", "islambader_1988"],
    ["أحمد حمدان", "AHM3D_HAMDAN"],
    ["معتصم دلول", "AbujomaaGaza"],
    ["علي جاد الله", "alijadallah66"],
    ["محمود بصل", "mahmoadbasal"],
  ]],
  ["أصوات غزة بالإنجليزية", [
    ["أبو بكر عابد", "AbubakerAbedW"],
    ["هند الخضري", "Hind_Gaza"],
    ["بليستيا العقاد", "PlestiaAlaqad"],
    ["مصعب أبو توها", "MosabAbuToha"],
    ["أحمد النعوق", "AhmedNaouq"],
    ["محمد شحادة", "muhammadshehad2"],
  ]],
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/") return htmlResponse(helpPage(url.origin, !!env.ACCESS_KEY));

      // حماية الرصيد: مفتاح وصول اختياري
      if (env.ACCESS_KEY && url.searchParams.get("key") !== env.ACCESS_KEY) {
        return textResponse("Unauthorized: missing or wrong ?key=", 401);
      }

      if (path === "/opml") {
        return opmlResponse(buildOpml(url.origin, env.ACCESS_KEY || ""));
      }

      if (!env.TWITTERAPI_KEY) {
        return textResponse("Server misconfigured: TWITTERAPI_KEY secret is not set", 500);
      }

      let target;
      if (path === "/feed") {
        target = parseXUrl(url.searchParams.get("url") || "");
        if (!target) return textResponse("Could not recognise this X/Twitter link", 400);
      } else if (path.startsWith("/user/")) {
        target = { type: "user", value: decodeURIComponent(path.slice(6)).replace(/^@/, "") };
      } else if (path === "/search") {
        const q = url.searchParams.get("q");
        if (!q) return textResponse("Missing ?q=", 400);
        target = { type: "search", value: q };
      } else {
        return textResponse("Not found", 404);
      }

      if (target.type === "user" && !/^[A-Za-z0-9_]{1,15}$/.test(target.value)) {
        return textResponse("Invalid username", 400);
      }

      const opts = {
        replies: url.searchParams.get("replies") === "1",
        retweets: url.searchParams.get("retweets") !== "0",
      };

      const selfUrl = new URL(url.origin + path);
      if (path === "/feed") selfUrl.searchParams.set("url", url.searchParams.get("url"));
      if (path === "/search") selfUrl.searchParams.set("q", target.value);

      // خلاصات الحسابات تُقرأ من مخزون الأرشفة الخلفية (KV) بدل الجلب الحي —
      // هذا يمنع اصطدام استيراد عشرات الخلاصات دفعة واحدة بحد الـ5 ثوانٍ.
      if (target.type === "user") {
        const { tweets, fetchedAt, fromArchive } = await getUserTweets(target.value, env, ctx);
        const filtered = filterTweets(tweets, opts);
        const xml = buildRss(target, filtered, opts, selfUrl.toString());
        return new Response(xml, {
          headers: {
            "content-type": "application/rss+xml; charset=utf-8",
            "cache-control": "public, max-age=300",
            "access-control-allow-origin": "*",
            "x-archived": fromArchive ? "1" : "0",
            "x-fetched-at": new Date(fetchedAt).toISOString(),
          },
        });
      }

      // البحث: يبقى حياً مع تخزين مؤقت قصير على حافة Cloudflare (ليس جزءاً من الأرشفة بالدور)
      const ttl = parseInt(env.CACHE_TTL || DEFAULT_TTL, 10);
      const cacheKey = new Request(
        `${url.origin}/__cache/search/${encodeURIComponent(target.value)}?r=${+opts.replies}&rt=${+opts.retweets}`
      );
      const cache = caches.default;
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      const rawTweets = await fetchTweets(target, env.TWITTERAPI_KEY);
      const filtered = filterTweets(rawTweets, opts);
      const xml = buildRss(target, filtered, opts, selfUrl.toString());

      const response = new Response(xml, {
        headers: {
          "content-type": "application/rss+xml; charset=utf-8",
          "cache-control": `public, max-age=${ttl}`,
          "access-control-allow-origin": "*",
        },
      });
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (err) {
      return textResponse(`Error: ${err.message}`, 502);
    }
  },

  // مشغّل Cron (انظر crons في wrangler.toml) — يؤرشف حساباً واحداً فقط في كل دورة
  async scheduled(event, env, ctx) {
    ctx.waitUntil(archiveNextAccount(env));
  },
};

/* ------------------------------------------------------------------ */
/* الأرشفة الخلفية (KV)                                                 */
/* ------------------------------------------------------------------ */

function allArchivedUsernames() {
  const seen = new Set();
  const usernames = [];
  for (const [, people] of ACCOUNT_GROUPS) {
    for (const [, username] of people) {
      const lower = username.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        usernames.push(username);
      }
    }
  }
  return usernames;
}

async function archiveNextAccount(env) {
  if (!env.TWITTERAPI_KEY || !env.TWEETS_KV) return;
  const usernames = allArchivedUsernames();
  if (!usernames.length) return;

  let cursor = parseInt((await env.TWEETS_KV.get("cursor")) || "0", 10);
  if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;
  const username = usernames[cursor % usernames.length];

  try {
    const tweets = await fetchTweets({ type: "user", value: username }, env.TWITTERAPI_KEY);
    await env.TWEETS_KV.put(
      `tw:${username.toLowerCase()}`,
      JSON.stringify({ tweets, fetchedAt: Date.now() }),
      { expirationTtl: 60 * 60 * 24 * 7 }
    );
  } catch (err) {
    // لا نحرّك المؤشر عند الفشل، فتُعاد محاولة نفس الحساب في الدورة القادمة
    console.error(`archive failed for @${username}: ${err.message}`);
    return;
  }
  await env.TWEETS_KV.put("cursor", String(cursor + 1));
}

async function getUserTweets(username, env, ctx) {
  const key = `tw:${username.toLowerCase()}`;
  if (env.TWEETS_KV) {
    const stored = await env.TWEETS_KV.get(key, "json");
    if (stored) return { tweets: stored.tweets, fetchedAt: stored.fetchedAt, fromArchive: true };
  }
  // لم يُؤرشف بعد (أول طلب لحساب غير موجود في ACCOUNT_GROUPS مثلاً) — نجلبه حياً
  // مرة واحدة ونخزّنه، فيصبح جاهزاً من المخزون في المرات القادمة.
  const tweets = await fetchTweets({ type: "user", value: username }, env.TWITTERAPI_KEY);
  const fetchedAt = Date.now();
  if (env.TWEETS_KV) {
    ctx.waitUntil(
      env.TWEETS_KV.put(key, JSON.stringify({ tweets, fetchedAt }), { expirationTtl: 60 * 60 * 24 * 7 })
    );
  }
  return { tweets, fetchedAt, fromArchive: false };
}

/* ------------------------------------------------------------------ */
/* تحليل روابط إكس                                                      */
/* ------------------------------------------------------------------ */

const RESERVED = new Set([
  "home", "explore", "search", "notifications", "messages", "i", "settings",
  "compose", "login", "signup", "tos", "privacy", "hashtag", "intent", "share",
]);

export function parseXUrl(input) {
  input = input.trim();
  if (!input) return null;
  if (/^@?[A-Za-z0-9_]{1,15}$/.test(input)) return { type: "user", value: input.replace(/^@/, "") };

  let u;
  try {
    u = new URL(/^https?:\/\//i.test(input) ? input : "https://" + input);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www\.|mobile\.)/, "");
  if (!["x.com", "twitter.com"].includes(host)) return null;

  const parts = u.pathname.split("/").filter(Boolean);
  if (parts[0] === "search" && u.searchParams.get("q")) {
    return { type: "search", value: u.searchParams.get("q") };
  }
  if (parts[0] === "hashtag" && parts[1]) {
    return { type: "search", value: "#" + decodeURIComponent(parts[1]) };
  }
  if (parts[0] && !RESERVED.has(parts[0].toLowerCase()) && /^[A-Za-z0-9_]{1,15}$/.test(parts[0])) {
    return { type: "user", value: parts[0] };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* جلب التغريدات                                                        */
/* ------------------------------------------------------------------ */

async function fetchTweets(target, apiKey) {
  let endpoint;
  if (target.type === "user") {
    endpoint = new URL(API_BASE + "/twitter/user/last_tweets");
    endpoint.searchParams.set("userName", target.value);
    // نجلب الردود دائماً هنا؛ تُستبعد لاحقاً وقت العرض حسب opts.replies — هذا يسمح
    // بتخزين نسخة كاملة واحدة في الأرشيف تصلح لأي خيارات عرض لاحقة دون إعادة جلب.
    endpoint.searchParams.set("includeReplies", "true");
  } else {
    endpoint = new URL(API_BASE + "/twitter/tweet/advanced_search");
    endpoint.searchParams.set("query", target.value);
    endpoint.searchParams.set("queryType", "Latest");
  }

  // الخطة المجانية في twitterapi.io تسمح بطلب واحد كل 5 ثوانٍ فقط — عند استيراد
  // عدة خلاصات دفعة واحدة (OPML) تصل الطلبات متزامنة تقريباً فتُرفض بـ429،
  // لذا نعيد المحاولة مع انتظار كافٍ بدل الفشل فوراً.
  const MAX_ATTEMPTS = 4;
  const RETRY_DELAY_MS = 6000;
  let res, body;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    res = await fetch(endpoint.toString(), { headers: { "X-API-Key": apiKey } });
    body = await res.text();
    if (res.status !== 429 || attempt === MAX_ATTEMPTS) break;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
  if (!res.ok) throw new Error(`twitterapi.io HTTP ${res.status}: ${body.slice(0, 200)}`);

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error("twitterapi.io returned non-JSON response");
  }
  if (data.status === "error") throw new Error(`twitterapi.io: ${data.message || data.msg || "unknown error"}`);

  // الاستجابة قد تأتي في tweets أو data.tweets — نتعامل مع الحالتين
  return data.tweets || (data.data && data.data.tweets) || [];
}

function filterTweets(tweets, opts) {
  let out = tweets;
  if (!opts.replies) out = out.filter((t) => !t.isReply);
  if (!opts.retweets) out = out.filter((t) => !t.retweeted_tweet);
  return out;
}

/* ------------------------------------------------------------------ */
/* بناء RSS                                                             */
/* ------------------------------------------------------------------ */

export function buildRss(target, tweets, opts, selfUrl) {
  const first = tweets[0];
  let title, link, description, image;

  if (target.type === "user") {
    const a = (first && first.author && first.author.userName.toLowerCase() === target.value.toLowerCase())
      ? first.author
      : (first && first.retweeted_tweet ? null : first && first.author);
    title = a && a.name ? `${a.name} (@${target.value}) — X` : `@${target.value} — X`;
    link = `https://x.com/${target.value}`;
    description = (a && a.description) || `تغريدات @${target.value}`;
    image = a && a.profilePicture;
  } else {
    title = `بحث إكس: ${target.value}`;
    link = `https://x.com/search?q=${encodeURIComponent(target.value)}&f=live`;
    description = `أحدث التغريدات لعبارة البحث: ${target.value}`;
  }

  const items = tweets.map(renderItem).join("\n");
  const lastBuild = first ? toRfc822(first.createdAt) : new Date().toUTCString();

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
<title>${esc(title)}</title>
<link>${esc(link)}</link>
<description>${esc(description)}</description>
<atom:link href="${esc(selfUrl)}" rel="self" type="application/rss+xml"/>
<lastBuildDate>${lastBuild}</lastBuildDate>
<generator>x-rss-worker</generator>
${image ? `<image><url>${esc(image)}</url><title>${esc(title)}</title><link>${esc(link)}</link></image>` : ""}
${items}
</channel>
</rss>`;
}

function renderItem(t) {
  const isRT = !!t.retweeted_tweet;
  const main = isRT ? t.retweeted_tweet : t;
  const author = t.author || {};
  const mainAuthor = main.author || author;
  const tweetUrl = main.url || `https://x.com/${mainAuthor.userName || "i"}/status/${main.id}`;

  const plain = cleanText(main);
  let title = plain.replace(/\s+/g, " ").trim();
  if (title.length > 120) title = title.slice(0, 117) + "…";
  if (!title) title = "(وسائط)";
  if (isRT) title = `🔁 @${mainAuthor.userName}: ${title}`;
  else if (t.isReply && t.inReplyToUsername) title = `↩︎ @${t.inReplyToUsername}: ${title}`;

  let html = "";
  if (isRT) html += `<p>🔁 أعاد <b>@${esc(author.userName || "")}</b> نشر تغريدة <b>${esc(mainAuthor.name || "")}</b> (@${esc(mainAuthor.userName || "")})</p>`;
  html += `<div dir="auto">${textToHtml(main)}</div>`;
  html += mediaHtml(main);

  if (main.quoted_tweet) {
    const q = main.quoted_tweet;
    const qa = q.author || {};
    html += `<blockquote dir="auto"><p><b>${esc(qa.name || "")}</b> @${esc(qa.userName || "")}</p>${textToHtml(q)}${mediaHtml(q)}<p><a href="${esc(q.url || "")}">التغريدة المقتبسة</a></p></blockquote>`;
  }

  const stats = [
    main.replyCount != null ? `💬 ${main.replyCount}` : "",
    main.retweetCount != null ? `🔁 ${main.retweetCount}` : "",
    main.likeCount != null ? `❤️ ${main.likeCount}` : "",
    main.viewCount != null ? `👁 ${main.viewCount}` : "",
  ].filter(Boolean).join(" · ");
  if (stats) html += `<p><small>${stats}</small></p>`;

  return `<item>
<title>${esc(title)}</title>
<link>${esc(tweetUrl)}</link>
<guid isPermaLink="false">x-${esc(t.id)}</guid>
<pubDate>${toRfc822(t.createdAt)}</pubDate>
<dc:creator>${esc(mainAuthor.name || mainAuthor.userName || "")}</dc:creator>
<description><![CDATA[${html.replace(/]]>/g, "]]&gt;")}]]></description>
</item>`;
}

/* نص التغريدة: نوسّع روابط t.co ونحذف روابط الوسائط الذيلية */
function cleanText(t) {
  let text = t.text || "";
  const urls = (t.entities && t.entities.urls) || [];
  for (const u of urls) if (u.url && u.expanded_url) text = text.split(u.url).join(u.expanded_url);
  if (getMedia(t).length) text = text.replace(/\s*https:\/\/t\.co\/\w+\s*$/, "");
  return text;
}

function textToHtml(t) {
  return esc(cleanText(t))
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/(^|[^\w])@([A-Za-z0-9_]{1,15})/g, '$1<a href="https://x.com/$2">@$2</a>')
    .replace(/(^|\s)#([\p{L}\p{N}_]+)/gu, (m, pre, tag) => `${pre}<a href="https://x.com/hashtag/${encodeURIComponent(tag)}">#${tag}</a>`)
    .replace(/\n/g, "<br>");
}

function getMedia(t) {
  return (t.extendedEntities && t.extendedEntities.media) ||
    (t.extended_entities && t.extended_entities.media) ||
    (t.entities && t.entities.media) || [];
}

function mediaHtml(t) {
  return getMedia(t).map((m) => {
    const src = m.media_url_https || m.media_url;
    if (!src) return "";
    if (m.type === "video" || m.type === "animated_gif") {
      const variants = ((m.video_info && m.video_info.variants) || [])
        .filter((v) => v.content_type === "video/mp4")
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (variants[0]) {
        return `<p><video controls poster="${esc(src)}" style="max-width:100%"><source src="${esc(variants[0].url)}" type="video/mp4"></video></p>`;
      }
    }
    return `<p><img src="${esc(src)}" style="max-width:100%" alt=""></p>`;
  }).join("");
}

function toRfc822(s) {
  const d = new Date(s);
  return isNaN(d) ? new Date().toUTCString() : d.toUTCString();
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;")
    // محارف تحكم غير مسموحة في XML
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function textResponse(msg, status) {
  return new Response(msg, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
function htmlResponse(html) {
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
function opmlResponse(xml) {
  return new Response(xml, {
    headers: {
      "content-type": "text/x-opml; charset=utf-8",
      "content-disposition": 'attachment; filename="feeds.opml"',
    },
  });
}

function buildOpml(origin, accessKey) {
  const outlines = ACCOUNT_GROUPS.map(([group, people]) => {
    const items = people.map(([name, username]) => {
      const feedUrl = new URL(`${origin}/feed`);
      feedUrl.searchParams.set("url", `https://x.com/${username}`);
      if (accessKey) feedUrl.searchParams.set("key", accessKey);
      return `      <outline text="${esc(name)}" title="${esc(name)}" type="rss" xmlUrl="${esc(feedUrl.toString())}" htmlUrl="${esc(`https://x.com/${username}`)}"/>`;
    }).join("\n");
    return `    <outline text="${esc(group)}" title="${esc(group)}">\n${items}\n    </outline>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>x-rss-worker feeds</title>
  </head>
  <body>
${outlines}
  </body>
</opml>`;
}

/* ------------------------------------------------------------------ */
/* صفحة المساعدة                                                        */
/* ------------------------------------------------------------------ */

function helpPage(origin, needsKey) {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>إكس إلى RSS</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;600&display=swap" rel="stylesheet">
<style>
  :root{--bg:#f7f7fb;--card:#fff;--fg:#1d1b2e;--muted:#6b6880;--accent:#5b4bdb;--border:#e3e1ef}
  @media (prefers-color-scheme:dark){:root{--bg:#14131c;--card:#1d1b29;--fg:#ecebf5;--muted:#9a97ad;--accent:#8f82ff;--border:#2d2a3d}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font-family:"IBM Plex Sans Arabic",system-ui,sans-serif;line-height:1.7}
  main{max-width:640px;margin:0 auto;padding:32px 16px}
  h1{font-size:1.6rem;margin:0 0 4px}
  p.sub{color:var(--muted);margin:0 0 24px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:20px;margin-bottom:16px}
  label{display:block;font-weight:600;margin:12px 0 6px}
  input[type=text]{width:100%;padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--fg);font:inherit;direction:ltr;text-align:left}
  .row{display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;color:var(--muted)}
  button{margin-top:16px;width:100%;padding:12px;border:0;border-radius:10px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
  #out{display:none;margin-top:16px}
  #out code{display:block;padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:10px;direction:ltr;text-align:left;word-break:break-all;font-size:.9rem}
  #err{color:#d64545;margin-top:12px;display:none}
  code.i{direction:ltr;unicode-bidi:embed;background:var(--bg);padding:1px 6px;border-radius:6px}
  ul{padding-inline-start:20px;margin:0}
</style>
</head>
<body>
<main>
  <h1>إكس ← RSS</h1>
  <p class="sub">الصق رابط حساب أو بحث من إكس لتحصل على رابط خلاصة RSS تضيفه إلى قارئك.</p>
  <div class="card">
    <label for="link">رابط إكس أو اسم المستخدم</label>
    <input id="link" type="text" placeholder="https://x.com/username">
    ${needsKey ? `<label for="key">مفتاح الوصول</label><input id="key" type="text" placeholder="ACCESS_KEY">` : ""}
    <div class="row">
      <label style="font-weight:400;margin:0"><input type="checkbox" id="replies"> تضمين الردود</label>
      <label style="font-weight:400;margin:0"><input type="checkbox" id="rts" checked> تضمين إعادة التغريد</label>
    </div>
    <button id="go">أنشئ رابط الخلاصة</button>
    <div id="err">لم أتعرّف على الرابط. جرّب رابط حساب مثل x.com/username أو رابط بحث.</div>
    <div id="out"><label>رابط RSS</label><code id="feed"></code><button id="copy">نسخ</button></div>
  </div>
  <div class="card">
    <b>صيغ مدعومة</b>
    <ul>
      <li>حساب: <code class="i">x.com/username</code> أو <code class="i">@username</code></li>
      <li>بحث: <code class="i">x.com/search?q=...</code></li>
      <li>وسم: <code class="i">x.com/hashtag/...</code></li>
    </ul>
  </div>
</main>
<script>
  const ORIGIN = ${JSON.stringify(origin)};
  const $ = (id) => document.getElementById(id);
  $("go").onclick = () => {
    const v = $("link").value.trim();
    $("err").style.display = "none"; $("out").style.display = "none";
    if (!v) return;
    const p = new URLSearchParams({ url: v });
    if ($("replies").checked) p.set("replies", "1");
    if (!$("rts").checked) p.set("retweets", "0");
    const k = $("key") && $("key").value.trim();
    if (k) p.set("key", k);
    const ok = /^@?[A-Za-z0-9_]{1,15}$/.test(v) || /(x|twitter)\\.com\\//i.test(v);
    if (!ok) { $("err").style.display = "block"; return; }
    $("feed").textContent = ORIGIN + "/feed?" + p.toString();
    $("out").style.display = "block";
  };
  $("copy").onclick = async () => {
    try { await navigator.clipboard.writeText($("feed").textContent); $("copy").textContent = "تم النسخ"; }
    catch { $("copy").textContent = "انسخ يدوياً"; }
    setTimeout(() => $("copy").textContent = "نسخ", 1500);
  };
</script>
</body>
</html>`;
}
