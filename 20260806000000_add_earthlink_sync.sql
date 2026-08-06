-- =====================================================================
-- يضيف ربط المشترك بحسابه على نظام Earthlink لدعم المزامنة التلقائية.
-- آمن للتشغيل على قاعدة البيانات الحية — هذا الملف إضافي فقط
-- (ADD COLUMN IF NOT EXISTS) ولا يحذف أو يغيّر أي بيانات موجودة.
-- شغّل هذا كامل مرة وحدة بـ Supabase SQL Editor.
-- =====================================================================

-- 1. معرّف المستخدم على Earthlink (مثال: "1@dqa310") — فريد لكل مشترك،
--    يُستخدم لمنع إضافة نفس المشترك مرتين عند تكرار المزامنة.
ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS earthlink_username text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscribers_earthlink_username
  ON subscribers(earthlink_username)
  WHERE earthlink_username IS NOT NULL;

-- 2. تاريخ انتهاء الاشتراك على Earthlink — للمرجعية فقط (اختياري).
ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS earthlink_expiration timestamptz;

-- 3. سجل عمليات المزامنة — لعرض تقرير آخر مزامنة بالواجهة
--    (تاريخها، عدد المضافين، عدد المتجاهَلين، هل نجحت أو فشلت).
CREATE TABLE IF NOT EXISTS earthlink_sync_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL CHECK (status IN ('success', 'error')),
  added_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE earthlink_sync_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_earthlink_sync_log" ON earthlink_sync_log;
DROP POLICY IF EXISTS "anon_insert_earthlink_sync_log" ON earthlink_sync_log;

CREATE POLICY "anon_select_earthlink_sync_log" ON earthlink_sync_log
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "anon_insert_earthlink_sync_log" ON earthlink_sync_log
  FOR INSERT TO anon, authenticated WITH CHECK (true);
