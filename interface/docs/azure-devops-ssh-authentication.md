# مصادقة Git مع Azure DevOps عبر SSH — المشكلة والحل

## الملخص

بعد التحويل من **HTTPS** إلى **SSH** لريبو `graphics-editor`، كانت أوامر مثل `git pull` و`git push` تفشل أو تطلب  
`git@ssh.dev.azure.com's password:`  
بينما **لا توجد كلمة مرور** صالحة لهذا المستخدم — المصادقة تتم بمفتاح SSH فقط.  
السبب كان **عدم تطابق نوع المفتاح**: الجهاز كان يقدّم مفتاح **Ed25519** الافتراضي، بينما المسجّل في Azure DevOps هو مفتاح **RSA** (`id_rsa`).

بعد إضافة إعداد صريح في `~/.ssh/config` لخادم Azure باستخدام **`~/.ssh/id_rsa`، اختفى طلب كلمة المرور ونجحت عمليات Git.

---

## ماذا كانت المشكلة؟ (بالتفصيل)

### 1) سلوك المستخدم

- الريموت مضبوط بشكل صحيح تقريبًا:
  - `git@ssh.dev.azure.com:v3/nagwa-limited/Content-Engineering/graphics-editor`
- عند تشغيل `git pull` أو `git push` أو `ssh -T git@ssh.dev.azure.com` يظهر:
  - `git@ssh.dev.azure.com's password:`

### 2) ماذا يعني طلب «password» هنا؟

في الاتصال **الصحيح** بـ Azure DevOps عبر SSH:

- المستخدم على الخادم هو `git` (ثابت).
- **لا يُستخدم** كلمة مرور حساب Microsoft لـ `git@ssh.dev.azure.com`.
- التعريف يتم بمطابقة **المفتاح العام** المرفوع في:  
  **User settings → SSH public keys** في Azure DevOps.

إذن ظهور `password:` يعني عادةً أن **المصادقة بالمفتاح فشلت**، وبرنامج SSH حاول سلوكًا احتياطيًا (مثل طلب كلمة مرور) أو أن الاتصال لا يزال ليس كما يتوقعه الخادم — وليس أن هناك «كلمة مرور» تُكتب من الواجهة.

### 3) السبب الجذري في هذه الحالة

على الجهاز كان الملف `~/.ssh/config` يحتوي:

```text
Host *
  AddKeysToAgent yes
  UseKeychain yes
  IdentityFile ~/.ssh/id_ed25519
```

- هذا يجعل **افتراضيًّا** الاعتماد على المفتاح **`id_ed25519`** لمعظم (أو كل) الاتصالات.
- المفتاح الذي أُضيف لاحقًا إلى Azure DevOps (مثلاً باسم مثل `Eslam_imac_key`) كان **من نوع RSA** — النوع المطابق لملفات:
  - `~/.ssh/id_rsa` (خاص)
  - `~/.ssh/id_rsa.pub` (عام)

أي أن:

| الموقع            | المفتاح المستخدم / المسجّل      |
|-------------------|---------------------------------|
| Azure DevOps      | المفتاح **العام** لـ **RSA**    |
| SSH على الجهاز   | بداية الاتصال بمفتاح **ed25519** (حسب `config` القديم) |

الخادم لا يقبل المفتاح المعروض (Ed25519 غير المطابق لما سجّلته)، فتفشل المصادقة، ثم يظهر سلوك يشبه طلب كلمة مرور.

### 4) ملاحظة عن الملفات الموجودة عادةً في `~/.ssh/`

- `id_ed25519` / `id_ed25519.pub` — مفتاح حديث (من نوع Ed25519).
- `id_rsa` / `id_rsa.pub` — مفتاح RSA.
- الاثنان قد يكونا موجودين؛ **Azure** هنا يرتبط بالمفتاح الذي **نسخته** إلى لوحة الـ SSH في البوابة (غالبًا `id_rsa.pub` إن كان نفس المفتاح RSA).

---

## ماذا عُدّل؟ (الحل)

تم تعديل `~/.ssh/config` لإضافة **قسم يسبق** `Host *` ويخص **فقط** خادم Azure:

```text
# Azure DevOps — use RSA key registered in Azure (not default ed25519)
Host ssh.dev.azure.com
  HostName ssh.dev.azure.com
  User git
  IdentityFile ~/.ssh/id_rsa
  IdentitiesOnly yes
```

ثم بقي الإعداد العام:

```text
Host *
  AddKeysToAgent yes
  UseKeychain yes
  IdentityFile ~/.ssh/id_ed25519
```

**لماذا هذا يعمل؟**

- `Host ssh.dev.azure.com` أخصّ من `Host *` — عند الاتصال بـ `ssh.dev.azure.com` تُطبَّق قواعد هذا القسم.
- `IdentityFile ~/.ssh/id_rsa` يفرض استخدام **المفتاح الخاص RSA** المقترن بما سجّلته في Azure.
- `IdentitiesOnly yes` يمنع إرسال مفاتيح أخرى قد تربك المحاولة الأولى.
- باقي الخوادم تظل تستخدم سلوك `Host *` مع `id_ed25519` إن رغبت بذلك.

**خطوة مكمّلة على macOS (إن لزم):** تحميل المفتاح في الوكيل:

```bash
ssh-add --apple-use-keychain ~/.ssh/id_rsa
```

**اختبار:**

```bash
ssh -T git@ssh.dev.azure.com
```

يُتوقع ظهور رسالة ترحيب/نجاح تخص Microsoft أو Azure **دون** طلب كلمة مرور. بعدها:

```bash
git pull --tags origin ok
git push origin ok
```

---

## دروس مختصرة

1. **Azure DevOps SSH = مفتاح عام**؛ ليس لـ `git@` «كلمة مرور» مثل تسجيل الدخول للموقع.
2. إن كان `Host *` يثبت `IdentityFile` لمفتاح واحد، فكل الخوادم قد تستخدمه — لازم يتطابق المسجّل على كل خادم.
3. إن سجّلت **RSA** في Azure و`config` يفرض **Ed25519** → فشل مصادقة.
4. الحل: **قسم `Host` خاص** بالدومين (هنا `ssh.dev.azure.com`) + `IdentityFile` الصحيح + `IdentitiesOnly yes` عند الحاجة.

---

## تاريخ

- مُوثّق بعد حل فعلي: اختفاء طلب `password` ونجاح `git pull` / `git push` باستخدام مفتاح RSA المطابق لـ Azure DevOps.
