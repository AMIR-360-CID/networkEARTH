/**
 * سكربت مزامنة Earthlink -> قسم الديون (subscribers)
 * -----------------------------------------------------
 * 1) يسجل دخول admin.earthlink.iq
 * 2) يفلتر المستخدمين Active ويجيبهم كلهم بصفحة وحدة (Page Size = 200)
 * 3) لكل مستخدم جديد (غير موجود سابقاً حسب earthlink_username):
 *    - يطابق اسم الباقة (Acc. Name) مع جدول plans عندنا
 *    - يضيفه كمشترك جديد برسوم = سعر بيع الباقة، ومدفوع = 0 (دَين)
 * 4) يسجل نتيجة العملية بجدول earthlink_sync_log
 *
 * التشغيل محلياً للاختبار:
 *   EARTHLINK_USERNAME=... EARTHLINK_PASSWORD=... \
 *   VITE_SUPABASE_URL=... VITE_SUPABASE_ANON_KEY=... \
 *   HEADLESS=false node scripts/syncEarthlink.js
 */

import puppeteer from 'puppeteer'
import { createClient } from '@supabase/supabase-js'

const {
  EARTHLINK_USERNAME,
  EARTHLINK_PASSWORD,
  VITE_SUPABASE_URL,
  VITE_SUPABASE_ANON_KEY,
  HEADLESS,
} = process.env

const LOGIN_URL = 'https://admin.earthlink.iq/Login.aspx'
const GRID_URL = 'https://admin.earthlink.iq/UserManagement.aspx'

const SEL = {
  loginUser: '#Login1_UserName',
  loginPass: '#Login1_Password',
  loginBtn: '#Login1_LoginButton',
  statusDropdown:
    '#ctl00_ctl00_MainContentPlaceHolder_MainContentPlaceHolder_statusdropdown',
  searchBtn:
    '#ctl00_ctl00_MainContentPlaceHolder_MainContentPlaceHolder_SearchButton',
  pageSizeArrow:
    '#ctl00_ctl00_MainContentPlaceHolder_MainContentPlaceHolder_UsersGrid_ctl00_ctl02_ctl01_PageSizeComboBox_Arrow',
}

function fail(msg) {
  console.error('خطأ: ' + msg)
  process.exit(1)
}

if (!EARTHLINK_USERNAME || !EARTHLINK_PASSWORD) {
  fail('لازم تحدد EARTHLINK_USERNAME و EARTHLINK_PASSWORD كمتغيرات بيئة')
}
if (!VITE_SUPABASE_URL || !VITE_SUPABASE_ANON_KEY) {
  fail('لازم تحدد VITE_SUPABASE_URL و VITE_SUPABASE_ANON_KEY كمتغيرات بيئة')
}

const supabase = createClient(VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)

// "27/02/2026 04:13 PM" -> ISO أو null لو الصيغة غير متوقعة
function parseEarthlinkDate(text) {
  if (!text) return null
  const m = text
    .trim()
    .match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})\s*(AM|PM)$/i)
  if (!m) return null
  let [, dd, mm, yyyy, hh, min, ap] = m
  hh = parseInt(hh, 10)
  if (ap.toUpperCase() === 'PM' && hh !== 12) hh += 12
  if (ap.toUpperCase() === 'AM' && hh === 12) hh = 0
  const iso = `${yyyy}-${mm}-${dd}T${String(hh).padStart(2, '0')}:${min}:00`
  const d = new Date(iso)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

async function scrapeActiveUsers(page) {
  console.log('فتح صفحة تسجيل الدخول...')
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' })
  await page.type(SEL.loginUser, EARTHLINK_USERNAME, { delay: 20 })
  await page.type(SEL.loginPass, EARTHLINK_PASSWORD, { delay: 20 })
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2' }),
    page.click(SEL.loginBtn),
  ])

  const url = page.url()
  if (url.includes('Login.aspx')) {
    throw new Error('فشل تسجيل الدخول - تأكد من صحة اليوزرنيم/الباسورد بالأسرار (Secrets)')
  }

  console.log('فتح صفحة Users Management وتفعيل فلتر Active...')
  await page.goto(GRID_URL, { waitUntil: 'networkidle2' })

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => null),
    page.select(SEL.statusDropdown, '1'), // 1 = Active
  ])

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => null),
    page.click(SEL.searchBtn),
  ])

  console.log('تغيير Page Size إلى 200 لجلب كل النتائج بصفحة وحدة...')
  try {
    await page.click(SEL.pageSizeArrow)
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('li')).some((li) => li.textContent.trim() === '200'),
      { timeout: 8000 },
    )
    const li200 = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll('li')).find((li) => li.textContent.trim() === '200'),
    )
    const el = li200.asElement()
    if (el) {
      await el.click()
      // تحديث الجدول عبر Ajax (UpdatePanel) - ننتظر هدوء الشبكة بدل تنقل كامل للصفحة
      await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => null)
    }
  } catch (e) {
    console.warn('تحذير: ما قدرنا نغيّر Page Size لـ 200، بنكمل بالحجم الافتراضي (قد يحتاج تصفح صفحات إضافية لاحقًا):', e.message)
  }

  console.log('قراءة بيانات المشتركين من الجدول...')
  const rows = await page.evaluate(() => {
    function getValueByLabel(row, labelText) {
      const labels = row.querySelectorAll('.gridlabel')
      for (const label of labels) {
        if (label.textContent.trim() === labelText) {
          const span = label.nextElementSibling
          return span ? span.textContent.trim() : ''
        }
      }
      return ''
    }

    const trs = Array.from(document.querySelectorAll('tr.userRow'))
    return trs.map((tr) => {
      const usernameEl = tr.querySelector('a.userIdLink')
      const nameEl = tr.querySelector('span.displayname')
      const expEl = tr.querySelector('td.expirationDate')
      return {
        username: usernameEl ? usernameEl.textContent.trim() : '',
        displayName: nameEl ? nameEl.textContent.trim() : '',
        accountName: getValueByLabel(tr, 'Acc. Name :'),
        accountStatus: getValueByLabel(tr, 'Acc. Status :'),
        mobile: getValueByLabel(tr, 'Mobile :'),
        expiration: expEl ? expEl.textContent.trim() : '',
      }
    })
  })

  return rows.filter((r) => r.username && r.accountStatus === 'Active')
}

async function syncToSupabase(activeUsers) {
  console.log(`تم جلب ${activeUsers.length} مستخدم Active. جاري المطابقة مع قاعدة البيانات...`)

  const { data: existing, error: existingErr } = await supabase
    .from('subscribers')
    .select('earthlink_username')
    .not('earthlink_username', 'is', null)
  if (existingErr) throw new Error('فشل قراءة المشتركين الحاليين: ' + existingErr.message)
  const existingUsernames = new Set((existing || []).map((r) => r.earthlink_username))

  const { data: plans, error: plansErr } = await supabase.from('plans').select('id, name, sell_price')
  if (plansErr) throw new Error('فشل قراءة جدول الباقات: ' + plansErr.message)
  const planByName = new Map((plans || []).map((p) => [p.name.trim().toLowerCase(), p]))

  let added = 0
  let skippedDuplicate = 0
  let skippedNoPlan = 0
  const missingPlanNames = new Set()

  for (const u of activeUsers) {
    if (existingUsernames.has(u.username)) {
      skippedDuplicate++
      continue
    }

    const plan = planByName.get((u.accountName || '').trim().toLowerCase())
    if (!plan) {
      skippedNoPlan++
      missingPlanNames.add(u.accountName || '(بدون اسم باقة)')
      continue
    }

    const { error: insertErr } = await supabase.from('subscribers').insert({
      name: u.displayName || u.username,
      phone: u.mobile || null,
      plan_id: plan.id,
      subscription_fee: plan.sell_price,
      paid_amount: 0,
      status: 'red',
      notes: 'مستورد تلقائيًا من Earthlink',
      earthlink_username: u.username,
      earthlink_expiration: parseEarthlinkDate(u.expiration),
    })

    if (insertErr) {
      console.error(`فشل إضافة ${u.username}:`, insertErr.message)
      continue
    }
    added++
    existingUsernames.add(u.username) // تحسّب لو تكرر نفس اليوزر بالنتائج
  }

  if (missingPlanNames.size > 0) {
    console.warn(
      'تنبيه: أسماء باقات موجودة بـ Earthlink وما إلها مطابقة بجدول الباقات عندك:',
      Array.from(missingPlanNames).join(', '),
    )
  }

  return { added, skippedDuplicate, skippedNoPlan, missingPlanNames: Array.from(missingPlanNames) }
}

async function logResult(status, result, errorMessage) {
  await supabase.from('earthlink_sync_log').insert({
    status,
    added_count: result?.added || 0,
    skipped_count: (result?.skippedDuplicate || 0) + (result?.skippedNoPlan || 0),
    error_message: errorMessage || null,
  })
}

async function main() {
  const browser = await puppeteer.launch({
    headless: HEADLESS === 'false' ? false : 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1366, height: 900 })

    const activeUsers = await scrapeActiveUsers(page)
    const result = await syncToSupabase(activeUsers)

    console.log('---')
    console.log(`تمت الإضافة: ${result.added}`)
    console.log(`تم تجاهله (مضاف من قبل): ${result.skippedDuplicate}`)
    console.log(`تم تجاهله (باقة غير مطابقة): ${result.skippedNoPlan}`)
    if (result.missingPlanNames.length > 0) {
      console.log('باقات محتاجة إضافة بجدول Plans:', result.missingPlanNames.join(', '))
    }

    await logResult('success', result, null)
  } catch (err) {
    console.error('فشلت عملية المزامنة:', err)
    await logResult('error', null, String(err.message || err)).catch(() => null)
    process.exitCode = 1
  } finally {
    await browser.close()
  }
}

main()
