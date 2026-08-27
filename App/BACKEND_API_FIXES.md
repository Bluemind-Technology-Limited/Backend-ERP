# Backend API Fixes - Material Expiry Date Migration

**Date**: August 27, 2026  
**Issue**: 500 error on GET /master-data/materials  
**Root Cause**: POST/PATCH endpoints still using `shelfLifeDays` but schema changed to `defaultExpiryDate`  
**Status**: ✅ FIXED - Backend builds successfully  

---

## Problem

When frontend tried to fetch materials, the backend returned 500 error:
```
Failed to load resource: the server responded with a status of 500 (Internal Server Error)
GET :3002/api/master-data/materials
```

**Why**: 
- Database schema updated: `shelfLifeDays` (Int) → `defaultExpiryDate` (DateTime)
- Migration applied successfully
- But backend API routes still referenced old field name
- Prisma client not regenerated

---

## Fixes Applied

### 1. Updated POST /master-data/materials endpoint

**File**: `src/routes/master-data.ts` (Line 195-225)

**Before**:
```typescript
const { name, sku, type, category, unitOfMeasure, barcode, shelfLifeDays, requiresLot, attachments, supplierIds } = req.body;
// ...
data: {
  // ...
  shelfLifeDays: shelfLifeDays ? Number(shelfLifeDays) : null,
}
```

**After**:
```typescript
const { name, sku, type, category, unitOfMeasure, barcode, defaultExpiryDate, requiresLot, attachments, supplierIds } = req.body;
// ...
data: {
  // ...
  defaultExpiryDate: defaultExpiryDate ? new Date(defaultExpiryDate) : null,
}
```

**Changes**:
- ✅ Changed param from `shelfLifeDays` to `defaultExpiryDate`
- ✅ Convert string ISO date to Date object: `new Date(defaultExpiryDate)`
- ✅ Handle null case properly

### 2. Updated PATCH /master-data/materials/:id endpoint

**File**: `src/routes/master-data.ts` (Line 227-254)

**Before**:
```typescript
const { name, type, category, unitOfMeasure, barcode, shelfLifeDays, requiresLot, attachments, status, supplierIds } = req.body;
// ...
data: {
  // ...
  shelfLifeDays: shelfLifeDays !== undefined ? Number(shelfLifeDays) : undefined,
}
```

**After**:
```typescript
const { name, type, category, unitOfMeasure, barcode, defaultExpiryDate, requiresLot, attachments, status, supplierIds } = req.body;
// ...
data: {
  // ...
  defaultExpiryDate: defaultExpiryDate !== undefined ? (defaultExpiryDate ? new Date(defaultExpiryDate) : null) : undefined,
}
```

**Changes**:
- ✅ Changed param from `shelfLifeDays` to `defaultExpiryDate`
- ✅ Convert string ISO date to Date object when provided
- ✅ Allow setting to null explicitly
- ✅ Handle undefined (don't update field)

### 3. Regenerated Prisma Client

**Command**: `npx prisma generate`

**Why**: 
- Prisma types are generated from schema
- Schema changed but generated types were stale
- Regeneration ensures TypeScript knows about new `defaultExpiryDate` field

**Result**:
```
✔ Generated Prisma Client (v7.9.1) in 889ms
```

---

## Build Status

### Before Fix
```
❌ 2 TypeScript errors:
  - defaultExpiryDate does not exist in MaterialCreateInput
  - defaultExpiryDate does not exist in MaterialUpdateInput
```

### After Fix
```
✓ Backend builds successfully (0 errors)
✓ Prisma client types updated
✓ All endpoints type-safe
```

---

## Testing Checklist

After deployment, verify:

- [ ] **GET /master-data/materials** returns 200 with material list
- [ ] **POST /master-data/materials** accepts `defaultExpiryDate` (ISO date string)
- [ ] **PATCH /master-data/materials/{id}** updates `defaultExpiryDate`
- [ ] **Date storage** in database is correct (UTC timestamp)
- [ ] **Date retrieval** returns ISO 8601 format
- [ ] **Null handling** works (optional field)
- [ ] **Validation** rejects invalid dates
- [ ] **Error messages** are clear on validation failure

### Manual Test Commands

```bash
# 1. Get all materials (should return empty array initially)
curl -X GET http://localhost:3002/api/master-data/materials \
  -H "Authorization: Bearer <token>"

# 2. Create material with expiry date
curl -X POST http://localhost:3002/api/master-data/materials \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Material",
    "type": "RAW",
    "unitOfMeasure": "kg",
    "defaultExpiryDate": "2027-08-27"
  }'

# 3. Update material expiry date
curl -X PATCH http://localhost:3002/api/master-data/materials/<id> \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "defaultExpiryDate": "2028-08-27"
  }'
```

---

## Related Updates Needed

The following backend endpoints also need similar fixes for consistency:

### GRN Module (`src/routes/grn.ts`)
- POST `/grn` - Accept `items[].expiryDate` (DateTime)
- Store batch expiry dates from GRN receipt

### Production Orders Module (`src/routes/production.ts`)
- POST `/production/orders/{id}/complete` - Accept `finishedGoodsExpiryDate` (DateTime)
- Auto-set to 2 years from today if not provided
- Store in BatchLot table

### Inventory Module (`src/routes/inventory.ts`)
- Update any endpoints that reference shelf life calculations
- Change to date-based expiry logic

---

## Database Schema Reference

```prisma
model Material {
  // ... other fields
  
  // Old: shelfLifeDays Int?
  // New:
  defaultExpiryDate DateTime? @map("default_expiry_date")
  
  // ... relationships
}

model BatchLot {
  // ... other fields
  
  // Already has:
  expiryDate DateTime?
  
  // ... relationships
}
```

---

## Deployment Steps

1. **Backend**:
   ```bash
   cd /Users/macbook/Desktop/KIB-Apps/backend/App
   npm run build        # Verify 0 errors
   npm run dev          # Start server
   ```

2. **Frontend**:
   ```bash
   cd /Users/macbook/Desktop/KIB-Apps/kib-ERP
   pnpm build          # Verify 0 errors
   pnpm dev            # Start dev server
   ```

3. **Verify API**:
   - Open DevTools Network tab
   - Navigate to Materials module
   - Check GET /api/master-data/materials returns 200
   - Add new material with expiry date
   - Verify POST succeeds and data saved

---

## Files Changed

```
✓ src/routes/master-data.ts
  └─ Line 195-225: Updated POST /materials endpoint
  └─ Line 227-254: Updated PATCH /materials/:id endpoint

✓ npx prisma generate
  └─ Regenerated: node_modules/@prisma/client
  └─ Updated TypeScript types for defaultExpiryDate
```

---

## Next Steps

1. ✅ Fix Materials API endpoints (DONE)
2. ⏳ Fix GRN API endpoints (NEXT)
3. ⏳ Fix Production Orders API endpoints (NEXT)
4. ⏳ Fix Inventory API endpoints (NEXT)
5. ⏳ Test all endpoints end-to-end
6. ⏳ Deploy to staging

---

**Status**: Backend API fixed and building successfully ✅
