-- Add columns to notifications table for low-stock alert system
-- SAFE: Only adds new columns with defaults, doesn't modify existing data

-- Step 1: Add new columns with defaults
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS notification_type VARCHAR(50) DEFAULT 'SYSTEM',
  ADD COLUMN IF NOT EXISTS reference_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS is_actionable BOOLEAN DEFAULT false;

-- Step 2: Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_notifications_user_type 
  ON notifications(user_id, notification_type, is_read);

CREATE INDEX IF NOT EXISTS idx_notifications_created 
  ON notifications(created_at DESC);

-- Step 3: Add comments for documentation
COMMENT ON COLUMN notifications.notification_type IS 'Type: LOW_STOCK_ALERT, APPROVAL_PENDING, SYSTEM, EXPIRY';
COMMENT ON COLUMN notifications.reference_id IS 'Foreign key reference: Material ID for low-stock alerts, GRN ID for approvals, etc.';
COMMENT ON COLUMN notifications.is_actionable IS 'True if user can take action directly (e.g., create requisition from alert)';
