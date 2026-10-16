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

يحتاج المشروع أيضاً مساحة KV للأرشفة الخلفية (مرة واحدة فقط):

```bash
npx wrangler kv namespace create TWEETS_KV
# ألصق id الناتج في wrangler.toml تحت [[kv_namespaces]]
```

## الاستخدام

| الهدف | الرابط |
|---|---|
| حساب | `https://<worker>/user/username` |
| بحث | `https://<worker>/search?q=from:username filter:media` |
| لصق رابط إكس كما هو | `https://<worker>/feed?url=https://x.com/username` |
| ملف OPML لكل حسابات ACCOUNT_GROUPS | `https://<worker>/opml` |
| صفحة توليد الروابط | `https://<worker>/` |

خيارات إضافية: `replies=1` لتضمين الردود، `retweets=0` لاستبعاد إعادة التغريد، `key=...` إذا ضبطت `ACCESS_KEY`.

البحث يقبل صيغة البحث المتقدم في إكس: `from:` و`OR` و`lang:ar` و`filter:media` و`-filter:replies` وغيرها. مثال لرصد عدة حسابات في خلاصة واحدة:

```
/search?q=from:account1 OR from:account2 OR from:account3
```

## الأرشفة الخلفية (للحسابات)

خلاصات الحسابات (`/user`, `/feed` لحساب) **لا تُجلب حيّاً وقت الطلب**. مشغّل cron (`crons` في `wrangler.toml`، كل 5 دقائق افتراضياً) يسحب حساباً واحداً فقط بالدور من قائمة `ACCOUNT_GROUPS` في `src/index.js` ويخزّن نتيجته في KV؛ القارئ يحصل على آخر نسخة مخزَّنة فوراً. هذا يناسب الاستخدام الأرشيفي (وليس المتابعة اللحظية)، ويحلّ مشكلة حد الـ5 ثوانٍ في الخطة المجانية لـtwitterapi.io عند استيراد عشرات الخلاصات دفعة واحدة في قارئ مثل Inoreader.

حساب غير موجود في `ACCOUNT_GROUPS` (مثلاً جرّبته من صفحة `/` مباشرة) يُجلب حياً عند أول طلب فقط، ثم يُخزَّن ويصبح من الأرشيف في المرات القادمة.

لإضافة أو حذف حسابات: عدّل `ACCOUNT_GROUPS` في `src/index.js` ثم `npx wrangler deploy`.

## الكلفة

كل أرشفة = طلب واحد يعيد حتى 20 تغريدة، مرة كل 5 دقائق بحد أقصى (وليس لكل قراءة). بعدد 40 حساباً مثلاً تُحدَّث كل دورة كاملة كل ~3.3 ساعة. لتسريع التحديث قلّل الفاصل الزمني في `crons`، أو اجمع حسابات متقاربة في خلاصة بحث واحدة بـ`OR` بدل الأرشفة الفردية.

## ما تحتويه كل مادة

النص الكامل مع توسيع روابط t.co، الصور والفيديو، التغريدة المقتبسة، إشارة إعادة التغريد والرد، وإحصاءات التفاعل.
