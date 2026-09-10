/**
 * Production Supervisor Test Runner
 * 
 * Run with: tsx src/scripts/test-supervisor.ts
 * 
 * This script validates:
 * - Batch allocation workflow (ALLOCATED → SCHEDULED → IN_PROGRESS → COMPLETED)
 * - Daily reconciliation with variance detection (auto-flag >5%)
 * - RBAC permissions for PRODUCTION_SUPERVISOR role
 * - Activity logging integration
 * - Machine workload calculations
 * - Reconciliation history retrieval
 */

import { PrismaClient } from '@prisma/client';
import {
  testBatchAllocationWorkflow,
  testDailyReconciliationVariance,
  testRBACPermissions,
  testActivityLogging,
  testMachineWorkloadCalculation,
  testReconciliationHistory,
  runAllTests,
} from '../__tests__/supervisorProduction.test.js';

const prisma = new PrismaClient();

async function main() {
  try {
    console.log('🔗 Connecting to database...');
    await prisma.$queryRaw`SELECT 1`;
    console.log('✓ Database connection successful\n');

    // Run all tests
    const success = await runAllTests(prisma);

    if (success) {
      console.log('🎉 All tests passed!');
      process.exit(0);
    } else {
      console.log('💥 Some tests failed');
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Test runner error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
