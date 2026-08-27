# Expiry Date Field Updates - Migration Guide

## Changes Made

### Database Schema (Prisma)

**Changed**: All expiration fields from **days (Int)** to **dates (DateTime)**

#### Material Table
```prisma
# OLD:
shelfLifeDays Int? @map("shelf_life_days")

# NEW:
defaultExpiryDate DateTime? @map("default_expiry_date")
```

#### BatchLot Table (Already Had Dates)
```prisma
✅ manufacturingDate DateTime? @map("manufacturing_date")
✅ expiryDate DateTime? @map("expiry_date")
```

---

## Migration Steps

### Step 1: Create Database Migration
```bash
cd backend/App
npx prisma migrate dev --name update_expiry_to_dates
```

### Step 2: Update Forms with Date Pickers

#### Material Form (Add/Edit)
Replace text input with date picker:

```typescript
// OLD
<input 
  type="text" 
  placeholder="Shelf life (days)" 
  name="shelfLifeDays"
/>

// NEW
<input 
  type="date" 
  name="defaultExpiryDate"
  value={form.defaultExpiryDate}
  onChange={(e) => setForm({...form, defaultExpiryDate: e.target.value})}
/>
```

#### GRN/Batch Forms
```typescript
// For each batch item, add expiry date picker:
<input 
  type="date" 
  name="expiryDate"
  required
  value={form.expiryDate}
  onChange={(e) => setForm({...form, expiryDate: e.target.value})}
/>
```

#### Goods Receipt Form
```typescript
// Add to each received item:
<label>Expiry Date</label>
<input 
  type="date" 
  name="expiryDate"
  value={batchItem.expiryDate}
  onChange={(e) => handleExpiryDateChange(index, e.target.value)}
/>
```

---

## Frontend Components to Update

### 1. Material Management
- **File**: `src/modules/masterdata/views/Materials.tsx`
- **Add**: Date picker for `defaultExpiryDate`

### 2. Goods Receipt
- **File**: `src/modules/inventory/views/GRN.tsx`
- **Add**: Date picker for each received batch `expiryDate`

### 3. Production Orders (Finished Goods)
- **File**: `src/modules/production/views/ProductionOrders.tsx`
- **Add**: Date picker for finished batch `expiryDate`

### 4. Batch Management
- **File**: `src/modules/qa/views/Inspections.tsx`
- **Update**: Show batch `expiryDate` with date picker

### 5. Inventory Display
- **File**: `src/modules/inventory/views/Inventory.tsx`
- **Update**: Show expiry dates in inventory table

---

## API Changes

### Update Material API
```typescript
// POST /master-data/materials
{
  name: "Cocoa Butter",
  sku: "CB-001",
  type: "RAW",
  unitOfMeasure: "kg",
  defaultExpiryDate: "2028-08-27", // ISO date format
  status: "ACTIVE"
}

// PATCH /master-data/materials/{id}
{
  defaultExpiryDate: "2028-08-27"
}
```

### Update Goods Receipt API
```typescript
// POST /inventory/grn
{
  poId: "po-123",
  items: [
    {
      materialId: "mat-456",
      quantity: 500,
      batchNumber: "CB-2026-001",
      expiryDate: "2028-08-27" // NEW: Date format
    }
  ]
}
```

### Update Production Order API
```typescript
// POST /production/production-orders/{id}/yield
{
  actualYield: 950,
  finishedBatchExpiryDate: "2028-08-27" // NEW: Date format
}
```

---

## Database Migration SQL

```sql
-- If manual migration needed:
ALTER TABLE materials
DROP COLUMN IF EXISTS shelf_life_days;

ALTER TABLE materials
ADD COLUMN default_expiry_date TIMESTAMP;

-- Migrate batch expiry dates (already have expiryDate column)
-- No action needed - already uses DateTime
```

---

## Validation Rules

### Frontend Validation
```typescript
// Expiry date must be in future
if (new Date(expiryDate) <= new Date()) {
  setError("Expiry date must be in the future");
  return;
}

// Expiry date should be reasonable (e.g., max 10 years)
const maxDate = new Date();
maxDate.setFullYear(maxDate.getFullYear() + 10);
if (new Date(expiryDate) > maxDate) {
  setWarning("Expiry date is unusually far in future");
}
```

### Backend Validation
```typescript
// Validate expiry date format
if (!isValidDate(expiryDate)) {
  return res.status(400).json({ error: "Invalid date format" });
}

// Check date is in future
if (new Date(expiryDate) <= new Date()) {
  return res.status(400).json({ error: "Expiry date must be in future" });
}
```

---

## Testing Checklist

- [ ] Create material with default expiry date
- [ ] Edit material expiry date
- [ ] Receive goods with specific expiry date
- [ ] View batch expiry dates in inventory
- [ ] Verify expiry alerts trigger correctly
- [ ] Test date picker on all forms
- [ ] Test date validation (no past dates)
- [ ] Test date display in tables
- [ ] Test inventory aging report
- [ ] Test expiry notifications

---

## Expiry Date Calculations

### Auto-Set Expiry Dates

**For Received Materials**:
```typescript
// User enters batch date or uses today
// Use material's defaultExpiryDate if available
const manufacturingDate = new Date(batchDate);
const expiryDate = new Date(manufacturingDate);

if (material.defaultExpiryDate) {
  // If default set, calculate days difference
  const daysUntilExpiry = calculateDaysBetween(
    manufacturingDate, 
    material.defaultExpiryDate
  );
  expiryDate.setDate(expiryDate.getDate() + daysUntilExpiry);
} else {
  // Default to 2 years if not specified
  expiryDate.setFullYear(expiryDate.getFullYear() + 2);
}
```

**For Finished Goods**:
```typescript
// Auto-set 2 years from production date
const productionDate = new Date();
const expiryDate = new Date(productionDate);
expiryDate.setFullYear(expiryDate.getFullYear() + 2);
```

---

## Reports & Alerts

### Expiry Monitoring Report
```typescript
// Show all batches with expiry dates
GET /reports/inventory-expiry

Response:
{
  batches: [
    {
      batchNumber: "CB-2026-001",
      material: "Cocoa Butter",
      quantity: 500,
      expiryDate: "2026-09-15",
      daysUntilExpiry: 19, // ← Auto-calculated
      status: "ACTIVE"
    }
  ]
}
```

### Expiry Alerts
```typescript
// Alert if batch expiring within 30 days
function checkExpiryAlerts(batches) {
  const thirtyDaysFromNow = new Date();
  thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
  
  return batches.filter(b => 
    new Date(b.expiryDate) <= thirtyDaysFromNow &&
    new Date(b.expiryDate) > new Date()
  );
}
```

---

## Rollback Plan (If Needed)

```bash
# Revert migration
npx prisma migrate resolve --rolled-back update_expiry_to_dates

# Restore old schema
npx prisma migrate dev --name restore_shelf_life_days
```

---

## Timeline

- **Day 1**: Update Prisma schema (✅ Done)
- **Day 2**: Create migration, update forms
- **Day 3**: Update APIs, add date pickers
- **Day 4**: Update reports, add alerts
- **Day 5**: Testing & deployment

---

## Files to Update

### Backend (Node.js/Express)
- [ ] `routes/materials.js` - Add defaultExpiryDate handling
- [ ] `routes/grn.js` - Add expiryDate to batch items
- [ ] `routes/production.js` - Auto-set finished goods expiry
- [ ] `validators/material.js` - Add date validation
- [ ] `controllers/inventory.js` - Update expiry calculations

### Frontend (React)
- [ ] `src/modules/masterdata/views/Materials.tsx` - Date picker
- [ ] `src/modules/inventory/views/GRN.tsx` - Date picker
- [ ] `src/modules/production/views/ProductionOrders.tsx` - Date display
- [ ] `src/modules/inventory/views/Inventory.tsx` - Date columns
- [ ] `src/modules/reports/views/Reports.tsx` - Expiry report
- [ ] `src/components/*/DatePicker.tsx` - Create reusable date picker component

---

## Date Picker Component Example

```typescript
// src/components/ui/DatePicker.tsx
import React from 'react';

interface DatePickerProps {
  label: string;
  value: string;
  onChange: (date: string) => void;
  required?: boolean;
  minDate?: string;
  maxDate?: string;
}

export function DatePicker({ 
  label, 
  value, 
  onChange, 
  required = false,
  minDate,
  maxDate 
}: DatePickerProps) {
  return (
    <div className="form-group">
      <label htmlFor="date-input" className="font-semibold">
        {label}
        {required && <span className="text-red-500">*</span>}
      </label>
      <input
        id="date-input"
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        min={minDate}
        max={maxDate}
        required={required}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500"
      />
    </div>
  );
}
```

---

**Status**: Ready for implementation  
**Next Step**: Run migration and update forms

