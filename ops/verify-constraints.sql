-- Constraint verification suite for schema.sql
-- Usage: createdb bi_test && psql -d bi_test -f schema.sql && psql -d bi_test -f verify-constraints.sql
-- Tests 1-5 and 7 MUST error. Test 0 must succeed. Test 6 must print the dates shown in ARCHITECTURE.md.

\set ON_ERROR_STOP off
-- fixtures
INSERT INTO users (id,email,full_name,password_hash,role_id)
 VALUES ('11111111-1111-1111-1111-111111111111','a@bi.pk','Admin','x',1);
INSERT INTO packages (code,name,speed_mbps,monthly_price) VALUES ('PKG-20M','20 Mbps',20,2500);
INSERT INTO customers (id,customer_code,full_name,status,billing_anchor_day)
 VALUES ('aaaaaaaa-0000-0000-0000-000000000001','BI-000124','Muhammad Ahmed','ACTIVE',15),
        ('bbbbbbbb-0000-0000-0000-000000000002','BI-000125','Ali Khan','ACTIVE',18);
INSERT INTO customer_whatsapp_numbers (customer_id,msisdn,state) VALUES
 ('aaaaaaaa-0000-0000-0000-000000000001','+923001234567','VALID'),
 ('bbbbbbbb-0000-0000-0000-000000000002','+923002222222','VALID');
INSERT INTO invoices (id,invoice_no,customer_id,package_name,package_speed_mbps,
  period_start,period_end,due_date,amount,total)
 VALUES ('cccccccc-0000-0000-0000-000000000001','INV-A','aaaaaaaa-0000-0000-0000-000000000001','20 Mbps',20,'2026-08-16','2026-09-15','2026-09-15',2500,2500),
        ('dddddddd-0000-0000-0000-000000000002','INV-B','bbbbbbbb-0000-0000-0000-000000000002','20 Mbps',20,'2026-08-19','2026-09-18','2026-09-18',2500,2500);
INSERT INTO whatsapp_templates (code,notification_type,provider_name,body)
 VALUES ('two_day','TWO_DAY_REMINDER','bi_two_day_ur','Reminder: {{1}}');

\echo '--- TEST 1: customer A + customer B number (must FAIL)'
INSERT INTO whatsapp_notifications (customer_id,recipient_msisdn,invoice_id,notification_type,
 template_id,customer_name,rendered_body,expiry_date_shown,scheduled_for)
 VALUES ('aaaaaaaa-0000-0000-0000-000000000001','+923002222222','cccccccc-0000-0000-0000-000000000001','TWO_DAY_REMINDER',1,'Muhammad Ahmed','x','2026-09-15',now());

\echo '--- TEST 2: customer A + customer B invoice (must FAIL)'
INSERT INTO whatsapp_notifications (customer_id,recipient_msisdn,invoice_id,notification_type,
 template_id,customer_name,rendered_body,expiry_date_shown,scheduled_for)
 VALUES ('aaaaaaaa-0000-0000-0000-000000000001','+923001234567','dddddddd-0000-0000-0000-000000000002','TWO_DAY_REMINDER',1,'Muhammad Ahmed','x','2026-09-15',now());

\echo '--- TEST 0: legitimate send (must SUCCEED)'
INSERT INTO whatsapp_notifications (customer_id,recipient_msisdn,invoice_id,notification_type,
 template_id,customer_name,rendered_body,expiry_date_shown,scheduled_for)
 VALUES ('aaaaaaaa-0000-0000-0000-000000000001','+923001234567','cccccccc-0000-0000-0000-000000000001','TWO_DAY_REMINDER',1,'Muhammad Ahmed','Reminder: 2026-09-15','2026-09-15',now());

\echo '--- TEST 3: duplicate reminder, same cycle (must FAIL)'
INSERT INTO whatsapp_notifications (customer_id,recipient_msisdn,invoice_id,notification_type,
 template_id,customer_name,rendered_body,expiry_date_shown,scheduled_for)
 VALUES ('aaaaaaaa-0000-0000-0000-000000000001','+923001234567','cccccccc-0000-0000-0000-000000000001','TWO_DAY_REMINDER',1,'Muhammad Ahmed','x','2026-09-15',now());

\echo '--- TEST 4: un-normalized phone (must FAIL)'
INSERT INTO customer_whatsapp_numbers (customer_id,msisdn) VALUES ('aaaaaaaa-0000-0000-0000-000000000001','03001234567');

\echo '--- TEST 5: over-length template (must FAIL)'
INSERT INTO whatsapp_templates (code,notification_type,provider_name,body)
 VALUES ('too_long','FINAL_EXPIRY_WARNING','x',repeat('ا',1100));

\echo '--- TEST 6: month-end billing math'
SELECT bi_cycle_end(31,2026,1) AS jan, bi_cycle_end(31,2026,2) AS feb,
       bi_cycle_end(31,2026,3) AS mar, bi_cycle_end(29,2028,2) AS leap_feb,
       bi_cycle_end(30,2026,2) AS d30_feb;

\echo '--- TEST 7: shared number across two customers (must FAIL)'
INSERT INTO customer_whatsapp_numbers (customer_id,msisdn) VALUES ('bbbbbbbb-0000-0000-0000-000000000002','+923001234567');

\echo '--- dues view'
SELECT customer_code, invoice_no, amount_due, days_overdue FROM customer_dues ORDER BY 1;
