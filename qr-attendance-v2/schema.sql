CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS admins(id SERIAL PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS participants(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,phone TEXT,qr_version INT NOT NULL DEFAULT 1,created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS events(id SERIAL PRIMARY KEY,name TEXT NOT NULL,date DATE,start_time TIME,end_time TIME,location TEXT,status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','closed')),created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS attendance(id SERIAL PRIMARY KEY,participant_id UUID NOT NULL REFERENCES participants(id) ON DELETE CASCADE,event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,marked_at TIMESTAMPTZ NOT NULL DEFAULT now(),marked_by INT REFERENCES admins(id),created_at TIMESTAMPTZ DEFAULT now(),UNIQUE(participant_id,event_id));
CREATE OR REPLACE VIEW attendance_status AS
SELECT p.id AS participant_id,p.name,p.email,p.phone,e.id AS event_id,e.name AS event_name,
CASE WHEN a.id IS NULL THEN 'Absent' ELSE 'Present' END AS status,a.marked_at
FROM participants p CROSS JOIN events e LEFT JOIN attendance a ON a.participant_id=p.id AND a.event_id=e.id;
