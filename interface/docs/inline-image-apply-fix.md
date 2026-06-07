# سلوك صور Inline عند «Apply» في إعدادات الصور

## السياق

في المحرر، أسئلة الـ HTML القادمة من Lexical تظهر الصور **داخل** الجملة (inline)، داخل `<span>` يحمل classes مثل `LexicalTheme__image` و`LexicalTheme__image--inline`، مع وسم `<img>` في الداخل.

بعد تعديل أبعاد الصورة (أو غيره) من لوحة **Image Settings** والضغط على **Apply**، كانت أيقونة المربع الأخضر **تنزل سطراً كاملاً بمفردها** بدل أن تبقى في نفس سطر نص السؤال.

---

## ماذا كان يحدث بالتفصيل؟

1. **استخراج الصور** (`extractImagesFromQuestion` في `ImageSettings.jsx`):
   - يُكتشف الوسم `<img>` ويُحدَّد إن كانت داخل wrapper قديم (`<div class="h-scroll">`) أو wrapper Lexical (`<span class="...LexicalTheme__image...">`).
   - لصور الـ inline يُقرأ `data-node-variation="inline"` من الـ span فيُخزَّن `variation: 'inline'` في الإعدادات المحلية.

2. **عند الضغط على Apply** (`applyChanges` → `updateImageInString`):
   - يُبنى وسم `<img>` جديد بأبعاد الـ `width` / `height` و`class="displayed-image"` و`style` يحتوي `aspect-ratio`.
   - **وضع Block:** كان الكود يلفّ الـ `<img>` في:
     ```html
     <span class="LexicalTheme__image LexicalTheme__image--block h-scroll" data-node-type="image" data-node-variation="block">...</span>
     ```
   - **وضع Inline:** كان الكود يستبدل الـ **span كاملًا + الصورة** بـ **الصورة وحدها** (`<img>` فقط)، بدون أي `<span class="LexicalTheme__image--inline">`.

3. **النتيجة:**
   - واجهة الـ **Question Engine** (داخل الـ iframe) تعتمد على هيكل Lexical: الـ span مع `LexicalTheme__image--inline` يجعل السلوك **inline** داخل الفقرة.
   - بإزالة ذلك الـ wrapper والاكتفاء بـ `<img class="displayed-image">`، تتغيّر طريقة عرض المحرّك للعنصر (مثلاً سلوك أقرب لعنصر مستقل أو سطر ينكسر بشكل مختلف)، فيظهر المربع **في سطر منفصل** عن بقية جملة «What is the number of …».

باختصار: **الخلل كان ليس في الأبعاد بحد ذاتها، بل في فقدان wrapper الـ Lexical للصور الـ inline بعد الـ Apply.**

---

## ماذا تغيّر (الإصلاح)؟

في `src/components/ImageSettings/ImageSettings.jsx` داخل `updateImageInString`، عند `variation !== 'block'` (أي **inline**):

- **قبل:** استبدال النطاق (بما فيه الـ span القديم) بـ `newImgTag` فقط (وسم img وحده).
- **بعد:** استبدال النطاق بوسيط يعيد **نفس نمط Lexical للصور الـ inline**:
  - `<span class="LexicalTheme__image LexicalTheme__image--inline h-scroll" data-node-type="image" data-node-variation="inline" style="vertical-align: middle;">`  
    + الوسم `<img>` المحدّث  
    + `</span>`

بهذا يبقى **نفس النوع من الـ DOM** تقريبًا كما في المحتوى الأصلي من Lexical، فيبقى السطر الواحد مع النص كما في المعاينة قبل الـ Apply.

---

## ملف مرتبط

- `src/components/ImageSettings/ImageSettings.jsx` — دالة `applyChanges` / `updateImageInString` (فرع inline بعد التعديل).

---

## تاريخ

- توثيق يطابق إصلاحًا لسلوك inline images بعد **Apply image setting changes** (مشكلة: الصورة تظهر في سطر لوحدها).
