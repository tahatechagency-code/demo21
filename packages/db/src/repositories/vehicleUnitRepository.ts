import type { Prisma, PrismaClient } from '@prisma/client';
import type { TenantId } from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

export interface CreateVehicleUnitInput {
  tenantId: TenantId;
  vehicleId: string;
  unitRef: string;
  status?: 'ACTIVE' | 'MAINTENANCE' | 'RETIRED';
}

export async function createVehicleUnit(db: Executor, input: CreateVehicleUnitInput) {
  return db.vehicleUnit.create({
    data: {
      tenantId: input.tenantId,
      vehicleId: input.vehicleId,
      unitRef: input.unitRef,
      status: input.status ?? 'ACTIVE',
    },
  });
}

export interface UnitCounts {
  activeUnits: number;
  maintenanceUnits: number;
}

/** Real, database-backed inventory counts — what `DatabaseFleetProvider` reads. */
export async function countUnitsByStatus(
  db: Executor,
  tenantId: TenantId,
  vehicleId: string,
): Promise<UnitCounts> {
  const rows = await db.vehicleUnit.groupBy({
    by: ['status'],
    where: { tenantId, vehicleId },
    _count: { _all: true },
  });
  const activeUnits = rows.find((row) => row.status === 'ACTIVE')?._count._all ?? 0;
  const maintenanceUnits = rows.find((row) => row.status === 'MAINTENANCE')?._count._all ?? 0;
  return { activeUnits, maintenanceUnits };
}

export async function listUnitsForVehicle(db: Executor, tenantId: TenantId, vehicleId: string) {
  return db.vehicleUnit.findMany({ where: { tenantId, vehicleId }, orderBy: { unitRef: 'asc' } });
}

/** Unit counts for every vehicle of the tenant in one query (the concierge reads the whole fleet per message). */
export async function countUnitsForAllVehicles(
  db: Executor,
  tenantId: TenantId,
): Promise<Map<string, UnitCounts>> {
  const rows = await db.vehicleUnit.groupBy({
    by: ['vehicleId', 'status'],
    where: { tenantId },
    _count: { _all: true },
  });
  const result = new Map<string, UnitCounts>();
  for (const row of rows) {
    const entry = result.get(row.vehicleId) ?? { activeUnits: 0, maintenanceUnits: 0 };
    if (row.status === 'ACTIVE') entry.activeUnits += row._count._all;
    if (row.status === 'MAINTENANCE') entry.maintenanceUnits += row._count._all;
    result.set(row.vehicleId, entry);
  }
  return result;
}
