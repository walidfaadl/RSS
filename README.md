# x-rss-worker

Cloudflare Worker يحوّل حسابات إكس (تويتر) وعمليات البحث والوسوم إلى خلاصات RSS 2.0 جاهزة لـInoreader أو أي قارئ آخر. مصدر البيانات: [twitterapi.io](https://twitterapi.io).

## النشر

```bash
npm install -g wrangler        # مرة واحدة
npx wrangler login
npx wrangler secret put TWITTERAPI_KEY   # الصق مفتاح twitterapi.io
npx wrangler secret put ACCESS_KEY       # اختياري لكن موصى به — أي كلمة سرية
npx wrangler deploy
```

أو اربطه بمستودع GitHub من لوحة Cloudflare (Workers → Create → Import repository) كما في `tg-rss-worker`، ثم أضف المتغيّرين السريين من Settings → Variables.

## الاستخدام

| الهدف | الرابط |
|---|---|
| حساب | `https://<worker>/user/username` |
| بحث | `https://<worker>/search?q=from:username filter:media` |
| لصق رابط إكس كما هو | `https://<worker>/feed?url=https://x.com/username` |
| صفحة توليد الروابط | `https://<worker>/` |

خيارات إضافية: `replies=1` لتضمين الردود، `retweets=0` لاستبعاد إعادة التغريد، `key=...` إذا ضبطت `ACCESS_KEY`.

البحث يقبل صيغة البحث المتقدم في إكس: `from:` و`OR` و`lang:ar` و`filter:media` و`-filter:replies` وغيرها. مثال لرصد عدة حسابات في خلاصة واحدة:

```
/search?q=from:account1 OR from:account2 OR from:account3
```

## الكلفة

كل تحديث للخلاصة = طلب واحد يعيد حتى 20 تغريدة. التخزين المؤقت (15 دقيقة افتراضياً عبر `CACHE_TTL`) يمنع تكرار الطلبات حين يستعلم القارئ أكثر من مرة. لتقليل الكلفة: اجمع الحسابات المتقاربة في خلاصة بحث واحدة بـ`OR` بدل خلاصة لكل حساب.

## ما تحتويه كل مادة

النص الكامل مع توسيع روابط t.co، الصور والفيديو، التغريدة المقتبسة، إشارة إعادة التغريد والرد، وإحصاءات التفاعل.
