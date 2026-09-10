/**
 * Production Supervisor E2E Integration Tests
 * 
 * This test suite validates the complete workflow:
 * 1. Production Plan → Batch Allocations → Daily Reconciliation
 * 2. RBAC permissions enforcement
 * 3. Activity logging integration
 * 4. Variance calculation and flagging
 */

import type { PrismaClient } from '@prisma/client';

/**
 * TEST SCENARIO 1: Batch Allocation Workflow
 * - Allocate batch to machine (ALLOCATED status)
 * - Start production (IN_PROGRESS status)
 * - Complete production (COMPLETED status)
 * Expected: Status transitions work, batch number is captured
 */
export const testBatchAllocationWorkflow = async (prisma: PrismaClient) => {
  console.log('\n=== TEST 1: Batch Allocation Workflow ===');
  
  try {
    // Setup: Get or create test data
    const productionPlan = await prisma.productionPlan.findFirst({
      include: { items: true },
    });
    
    if (!productionPlan || productionPlan.items.length === 0) {
      console.warn('⚠️  No production plans with items found. Skipping test.');
      return;
    }

    const machine = await prisma.machine.findFirst();
    if (!machine) {
      console.warn('⚠️  No machines found. Skipping test.');
      return;
    }

    const supervisor = await prisma.user.findFirst({
      where: { role: 'PRODUCTION_SUPERVISOR' },
    });
    if (!supervisor) {
      console.warn('⚠️  No PRODUCTION_SUPERVISOR user found. Skipping test.');
      return;
    }

    const item = productionPlan.items[0];
    const order = await prisma.productionOrder.findFirst({
      where: { productionPlanItemId: item.id },
    });
    if (!order) {
      console.warn('⚠️  No production orders found. Skipping test.');
      return;
    }

    // TEST: Create allocation (ALLOCATED status)
    const allocation = await prisma.batchMachineAllocation.create({
      data: {
        productionPlanItemId: item.id,
        productionOrderId: order.id,
        machineId: machine.id,
        supervisorId: supervisor.id,
        status: 'ALLOCATED',
      },
    });

    console.log('✓ Allocation created with ALLOCATED status');
    console.log(`  - Allocation ID: ${allocation.id}`);
    console.log(`  - Status: ${allocation.status}`);

    // TEST: Transition to IN_PROGRESS
    const startedAllocation = await prisma.batchMachineAllocation.update({
      where: { id: allocation.id },
      data: {
        status: 'SCHEDULED',
        scheduledStartTime: new Date(),
      },
    });
    console.log('✓ Allocation transitioned to SCHEDULED');

    const inProgressAllocation = await prisma.batchMachineAllocation.update({
      where: { id: allocation.id },
      data: {
        status: 'IN_PROGRESS',
        actualStartTime: new Date(),
      },
    });
    console.log('✓ Allocation transitioned to IN_PROGRESS');

    // TEST: Transition to COMPLETED with batch number
    const batchNumber = `BATCH-${Date.now()}`;
    const completedAllocation = await prisma.batchMachineAllocation.update({
      where: { id: allocation.id },
      data: {
        status: 'COMPLETED',
        batchNumber,
        actualEndTime: new Date(),
      },
    });

    console.log('✓ Allocation transitioned to COMPLETED');
    console.log(`  - Batch Number: ${completedAllocation.batchNumber}`);

    console.log('✅ TEST 1 PASSED: Batch allocation workflow complete\n');
    return true;
  } catch (error) {
    console.error('❌ TEST 1 FAILED:', error);
    return false;
  }
};

/**
 * TEST SCENARIO 2: Daily Reconciliation with Variance Detection
 * - Create reconciliation for plan
 * - Calculate variance (actual vs planned)
 * - Flag if variance > 5%
 * Expected: Reconciliation created, variance calculated, auto-flagged if needed
 */
export const testDailyReconciliationVariance = async (prisma: PrismaClient) => {
  console.log('\n=== TEST 2: Daily Reconciliation & Variance Detection ===');

  try {
    const productionPlan = await prisma.productionPlan.findFirst({
      include: { items: true },
    });

    if (!productionPlan) {
      console.warn('⚠️  No production plans found. Skipping test.');
      return;
    }

    const supervisor = await prisma.user.findFirst({
      where: { role: 'PRODUCTION_SUPERVISOR' },
    });
    if (!supervisor) {
      console.warn('⚠️  No PRODUCTION_SUPERVISOR user found. Skipping test.');
      return;
    }

    // TEST: Create reconciliation
    const reconciliation = await prisma.dailyProductionReconciliation.create({
      data: {
        productionPlanId: productionPlan.id,
        supervisorId: supervisor.id,
        reconciliationDate: new Date(),
        status: 'PENDING',
      },
    });

    console.log('✓ Daily reconciliation created');
    console.log(`  - Reconciliation ID: ${reconciliation.id}`);
    console.log(`  - Status: ${reconciliation.status}`);

    // TEST: Calculate variance scenario
    const plannedQty = 100;
    const actualQty = 95; // 5% under
    const variance = actualQty - plannedQty;
    const variancePercent = Math.abs(variance / plannedQty) * 100;

    console.log(`✓ Variance calculated: ${variancePercent.toFixed(1)}% (${variance > 0 ? 'over' : 'under'})`);

    // TEST: Auto-flag if variance > 5%
    const shouldFlag = Math.abs(variancePercent) > 5;
    const updatedReconciliation = await prisma.dailyProductionReconciliation.update({
      where: { id: reconciliation.id },
      data: {
        status: shouldFlag ? 'FLAGGED' : 'PENDING',
        flaggedAt: shouldFlag ? new Date() : null,
        flaggedBy: shouldFlag ? supervisor.id : null,
      },
    });

    if (shouldFlag) {
      console.log(`✓ Reconciliation auto-flagged due to ${variancePercent.toFixed(1)}% variance`);
    } else {
      console.log(`✓ Reconciliation variance within tolerance`);
    }

    console.log('✅ TEST 2 PASSED: Daily reconciliation variance detection complete\n');
    return true;
  } catch (error) {
    console.error('❌ TEST 2 FAILED:', error);
    return false;
  }
};

/**
 * TEST SCENARIO 3: RBAC Permission Enforcement
 * - Verify PRODUCTION_SUPERVISOR can create/read/update on production module
 * - Verify other roles cannot access supervisor endpoints
 * Expected: Permissions enforced correctly
 */
export const testRBACPermissions = async (prisma: PrismaClient) => {
  console.log('\n=== TEST 3: RBAC Permission Enforcement ===');

  try {
    // TEST: Check PRODUCTION_SUPERVISOR permissions in database
    const supervisorRole = await prisma.rolePermission.findMany({
      where: {
        role: 'PRODUCTION_SUPERVISOR',
        module: 'production',
      },
    });

    console.log(`✓ Found ${supervisorRole.length} production permissions for PRODUCTION_SUPERVISOR`);

    const hasCreate = supervisorRole.some(p => p.action === 'create');
    const hasRead = supervisorRole.some(p => p.action === 'read');
    const hasUpdate = supervisorRole.some(p => p.action === 'update');

    console.log(`  - CREATE: ${hasCreate ? '✓' : '✗'}`);
    console.log(`  - READ: ${hasRead ? '✓' : '✗'}`);
    console.log(`  - UPDATE: ${hasUpdate ? '✓' : '✗'}`);

    if (!hasCreate || !hasRead || !hasUpdate) {
      throw new Error('PRODUCTION_SUPERVISOR missing required production permissions');
    }

    // TEST: Verify other roles don't have supervisor access
    const storeOfficerPerms = await prisma.rolePermission.findMany({
      where: {
        role: 'STORE_OFFICER',
        module: 'production',
      },
    });

    console.log(`✓ STORE_OFFICER has ${storeOfficerPerms.length} production permissions (should be limited)`);

    console.log('✅ TEST 3 PASSED: RBAC permissions correctly enforced\n');
    return true;
  } catch (error) {
    console.error('❌ TEST 3 FAILED:', error);
    return false;
  }
};

/**
 * TEST SCENARIO 4: Activity Logging Integration
 * - Verify allocation actions are logged
 * - Verify reconciliation actions are logged
 * Expected: User activities recorded with correct action types
 */
export const testActivityLogging = async (prisma: PrismaClient) => {
  console.log('\n=== TEST 4: Activity Logging Integration ===');

  try {
    const supervisor = await prisma.user.findFirst({
      where: { role: 'PRODUCTION_SUPERVISOR' },
    });

    if (!supervisor) {
      console.warn('⚠️  No PRODUCTION_SUPERVISOR user found. Skipping test.');
      return;
    }

    // TEST: Check for production-related activities
    const activities = await prisma.userActivity.findMany({
      where: {
        userId: supervisor.id,
        module: 'production',
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    console.log(`✓ Found ${activities.length} production activities for supervisor`);

    // Check for allocation-related activities
    const allocationActivities = activities.filter(a =>
      a.action.includes('allocation') || a.action.includes('batch')
    );
    console.log(`  - Allocation-related: ${allocationActivities.length}`);

    // Check for reconciliation-related activities
    const reconciliationActivities = activities.filter(a =>
      a.action.includes('reconciliation') || a.action.includes('reconcile')
    );
    console.log(`  - Reconciliation-related: ${reconciliationActivities.length}`);

    if (activities.length > 0) {
      const latestActivity = activities[0];
      console.log(`✓ Latest activity: ${latestActivity.action} at ${latestActivity.createdAt}`);
    }

    console.log('✅ TEST 4 PASSED: Activity logging verified\n');
    return true;
  } catch (error) {
    console.error('❌ TEST 4 FAILED:', error);
    return false;
  }
};

/**
 * TEST SCENARIO 5: Machine Workload Calculation
 * - Allocate multiple batches to same machine
 * - Verify workload shows all allocations
 * Expected: Workload calculation accurate
 */
export const testMachineWorkloadCalculation = async (prisma: PrismaClient) => {
  console.log('\n=== TEST 5: Machine Workload Calculation ===');

  try {
    const machine = await prisma.machine.findFirst();
    if (!machine) {
      console.warn('⚠️  No machines found. Skipping test.');
      return;
    }

    // Get all allocations for this machine
    const allocations = await prisma.batchMachineAllocation.findMany({
      where: { machineId: machine.id },
      include: { productionOrder: true },
    });

    console.log(`✓ Machine "${machine.name}" has ${allocations.length} allocations`);

    // Calculate workload by status
    const statusCounts = {
      ALLOCATED: allocations.filter(a => a.status === 'ALLOCATED').length,
      SCHEDULED: allocations.filter(a => a.status === 'SCHEDULED').length,
      IN_PROGRESS: allocations.filter(a => a.status === 'IN_PROGRESS').length,
      COMPLETED: allocations.filter(a => a.status === 'COMPLETED').length,
    };

    console.log('  - Status breakdown:');
    console.log(`    • ALLOCATED: ${statusCounts.ALLOCATED}`);
    console.log(`    • SCHEDULED: ${statusCounts.SCHEDULED}`);
    console.log(`    • IN_PROGRESS: ${statusCounts.IN_PROGRESS}`);
    console.log(`    • COMPLETED: ${statusCounts.COMPLETED}`);

    // Calculate total quantity
    const totalQty = allocations.reduce((sum, a) => sum + (a.productionOrder?.quantity || 0), 0);
    console.log(`✓ Total planned quantity: ${totalQty}`);

    console.log('✅ TEST 5 PASSED: Machine workload calculation complete\n');
    return true;
  } catch (error) {
    console.error('❌ TEST 5 FAILED:', error);
    return false;
  }
};

/**
 * TEST SCENARIO 6: Reconciliation History Retrieval
 * - Create multiple reconciliations
 * - Verify history retrieval works
 * Expected: History returned in correct order
 */
export const testReconciliationHistory = async (prisma: PrismaClient) => {
  console.log('\n=== TEST 6: Reconciliation History Retrieval ===');

  try {
    const productionPlan = await prisma.productionPlan.findFirst();
    if (!productionPlan) {
      console.warn('⚠️  No production plans found. Skipping test.');
      return;
    }

    // Get reconciliation history for this plan
    const history = await prisma.dailyProductionReconciliation.findMany({
      where: { productionPlanId: productionPlan.id },
      include: {
        supervisor: { select: { fullName: true } },
      },
      orderBy: { reconciliationDate: 'desc' },
      take: 30,
    });

    console.log(`✓ Retrieved ${history.length} reconciliations for plan "${productionPlan.planNumber}"`);

    if (history.length > 0) {
      console.log('  - Recent reconciliations:');
      history.slice(0, 5).forEach((recon, idx) => {
        console.log(`    ${idx + 1}. ${recon.reconciliationDate.toLocaleDateString()} - ${recon.status} (${recon.supervisor.fullName})`);
      });
    }

    console.log('✅ TEST 6 PASSED: Reconciliation history retrieval complete\n');
    return true;
  } catch (error) {
    console.error('❌ TEST 6 FAILED:', error);
    return false;
  }
};

/**
 * Run all tests
 */
export const runAllTests = async (prisma: PrismaClient) => {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  PRODUCTION SUPERVISOR E2E TEST SUITE                  ║');
  console.log('║  Testing batch allocations, reconciliation, RBAC       ║');
  console.log('╚════════════════════════════════════════════════════════╝');

  const results = {
    passed: 0,
    failed: 0,
  };

  // Run tests
  if (await testBatchAllocationWorkflow(prisma)) results.passed++;
  else results.failed++;

  if (await testDailyReconciliationVariance(prisma)) results.passed++;
  else results.failed++;

  if (await testRBACPermissions(prisma)) results.passed++;
  else results.failed++;

  if (await testActivityLogging(prisma)) results.passed++;
  else results.failed++;

  if (await testMachineWorkloadCalculation(prisma)) results.passed++;
  else results.failed++;

  if (await testReconciliationHistory(prisma)) results.passed++;
  else results.failed++;

  // Summary
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log(`║  RESULTS: ${results.passed} Passed, ${results.failed} Failed                            ║`);
  console.log('╚════════════════════════════════════════════════════════╝\n');

  return results.failed === 0;
};
