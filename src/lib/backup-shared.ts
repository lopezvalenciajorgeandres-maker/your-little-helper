export const SHEETS = {
  clients: "Clientes",
  services: "Servicios",
  professionals: "Profesionales",
  appointments: "Citas",
  payments: "Pagos",
  expenses: "Gastos",
  notes: "Notas",
  balances: "Saldos",
} as const;

export type BackupCell = string | number | null;
export type BackupSheets = Record<string, Array<Record<string, BackupCell>>>;
