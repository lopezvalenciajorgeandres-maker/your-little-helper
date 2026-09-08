import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listClients, createClient } from "@/lib/clients.functions";
import { listServices } from "@/lib/services.functions";
import { completeAppointmentSession, createAppointment, deleteAppointment, listAppointments, updateAppointment } from "@/lib/appointments.functions";
import { Check, CheckCircle2, ChevronLeft, ChevronRight, Clock, Copy, Link2, Lock, LockOpen, MessageCircle, Plus, Trash2, X } from "lucide-react";
import { createBlock, deleteBlock, listHours } from "@/lib/schedule.functions";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ClientForm, type ClientPayload } from "@/components/app/client-form";
import { Modal } from "@/components/app/kit";
import { BackupButtons } from "@/components/app/backup-buttons";
import { closeTreatment, createTreatment, listTreatments, updateTreatment, type TreatmentSummary } from "@/lib/treatments.functions";
import { useTenant } from "@/lib/use-tenant";
import { formatMoney } from "@/lib/plan";


export const Route = createFileRoute("/_authenticated/app/agenda")({
  head: () => ({
    meta: [
      { title: "Agenda de citas — Eleva System" },
      {
        name: "description",
        content: "Gestiona citas, clientes y recordatorios manuales de WhatsApp desde la agenda de Eleva System.",
      },
      { property: "og:title", content: "Agenda de citas — Eleva System" },
      {
        property: "og:description",
        content: "Agenda semanal para gestionar citas y enviar recordatorios manuales por WhatsApp.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Agenda,
});

const DAY_NAMES = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];
const HOURS = Array.from({ length: 16 }, (_, i) => i + 6); // 06..21
const SLOT_MIN = 15; // franjas de 15 minutos
const SLOT_PX = 22; // px por franja de 15 min
const SLOT_HEIGHT = SLOT_PX * (60 / SLOT_MIN); // px por hora
const SLOTS = Array.from(
  { length: HOURS.length * (60 / SLOT_MIN) },
  (_, i) => HOURS[0] * 60 + i * SLOT_MIN,
); // 360, 375, ...
const fmtSlot = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function startOfWeek(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = (x.getDay() + 6) % 7; // Monday=0
  x.setDate(x.getDate() - day);
  return x;
}

function Agenda() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [presetDay, setPresetDay] = useState<Date | null>(null);
  const [modal, setModal] = useState(false);
  const [reminder, setReminder] = useState<WhatsAppReminder | null>(null);
  const [editAppt, setEditAppt] = useState<any | null>(null);
  const [drag, setDrag] = useState<{
    id: string;
    grabDy: number;
    colWidth: number;
    dayIndex: number;
    minutes: number;
    moved: boolean;
  } | null>(null);
  const [resize, setResize] = useState<{
    id: string;
    edge: "top" | "bottom";
    startMin: number;
    endMin: number;
    moved: boolean;
  } | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  const qc = useQueryClient();
  const getAppts = useServerFn(listAppointments);
  const getClients = useServerFn(listClients);
  const getServices = useServerFn(listServices);
  const create = useServerFn(createAppointment);
  const del = useServerFn(deleteAppointment);
  const update = useServerFn(updateAppointment);
  const createCli = useServerFn(createClient);
  const createTreat = useServerFn(createTreatment);
  const updateTreat = useServerFn(updateTreatment);
  const closeTreat = useServerFn(closeTreatment);
  const completeAppt = useServerFn(completeAppointmentSession);
  const getTreatments = useServerFn(listTreatments);
  const tenant = useTenant();

  const from = new Date(weekStart);
  const to = new Date(weekStart);
  to.setDate(to.getDate() + 7);
  to.setMilliseconds(-1);

  const appts = useQuery({
    queryKey: ["appts", "week", weekStart.toISOString()],
    queryFn: () => getAppts({ data: { from: from.toISOString(), to: to.toISOString() } }),
  });
  const clients = useQuery({ queryKey: ["clients"], queryFn: () => getClients() });
  const services = useQuery({ queryKey: ["services"], queryFn: () => getServices() });
  const treatments = useQuery({
    queryKey: ["treatments"],
    queryFn: () => getTreatments(),
    
  });
  const getSchedule = useServerFn(listHours);
  const addBlock = useServerFn(createBlock);
  const removeBlock = useServerFn(deleteBlock);
  const schedule = useQuery({ queryKey: ["schedule"], queryFn: () => getSchedule() });
  const blocks = (schedule.data?.blocks ?? []) as Array<{
    id: string;
    starts_at: string;
    ends_at: string;
    reason: string | null;
    kind: string;
  }>;

  const blockMut = useMutation({
    mutationFn: (v: { starts_at: string; ends_at: string; reason?: string | null; kind?: string }) =>
      addBlock({ data: { kind: "bloqueo", ...v } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedule"] });
      toast.success("Horario bloqueado — ya no aparece disponible en el enlace de reservas");
    },
    onError: (e: any) => toast.error(e?.message ?? "No se pudo bloquear"),
  });

  const unblockMut = useMutation({
    mutationFn: (ids: string[]) => Promise.all(ids.map((id) => removeBlock({ data: { id } }))),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedule"] });
      toast.success("Bloqueo liberado");
    },
    onError: (e: any) => toast.error(e?.message ?? "No se pudo liberar el bloqueo"),
  });


  const pendingOnline = useMemo(
    () =>
      [...(appts.data ?? [])]
        .filter((a: any) => a.status === "pending")
        .sort((a: any, b: any) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime()),
    [appts.data],
  );

  const statusMut = useMutation({
    mutationFn: (v: { id: string; status: "scheduled" | "cancelled" }) => update({ data: v }),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ["appts"] });
      toast.success(v.status === "scheduled" ? "Reserva confirmada" : "Reserva rechazada — horario liberado");
    },
    onError: (e: any) => toast.error(e?.message ?? "No se pudo actualizar la reserva"),
  });


  const deleteMut = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["appts"] });
      toast.success("Cita eliminada");
    },
  });

  const moveMut = useMutation({
    mutationFn: (v: { id: string; starts_at: string; ends_at: string; service_id?: string | null; price_cents?: number | null }) =>
      update({ data: v }),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ["appts"] });
      const d = new Date(v.starts_at);
      toast.success(
        `Cita reagendada: ${d.toLocaleDateString("es", { weekday: "long", day: "numeric", month: "short" })} ${d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}`,
      );
    },
    onError: (e: any) => toast.error(e?.message ?? "No se pudo reagendar la cita"),
  });

  const updateTreatMut = useMutation({
    mutationFn: (v: { id: string; total_cents?: number; sessions_total?: number }) => updateTreat({ data: v }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["treatments"] });
      toast.success("Tratamiento actualizado");
    },
    onError: (e: any) => toast.error(e?.message ?? "No se pudo actualizar el tratamiento"),
  });

  const closeTreatMut = useMutation({
    mutationFn: (v: { id: string; reopen?: boolean }) => closeTreat({ data: v }),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ["treatments"] });
      qc.invalidateQueries({ queryKey: ["receivables"] });
      toast.success(v.reopen ? "Tratamiento reabierto" : "Tratamiento finalizado");
    },
    onError: (e: any) => toast.error(e?.message ?? "No se pudo actualizar el tratamiento"),
  });

  const completeApptMut = useMutation({
    mutationFn: (v: { id: string; completed: boolean }) => completeAppt({ data: v }),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ["appts"] });
      qc.invalidateQueries({ queryKey: ["treatments"] });
      toast.success(v.completed ? "Sesión marcada como realizada" : "Sesión marcada como no realizada");
    },
    onError: (e: any) => toast.error(e?.message ?? "No se pudo actualizar la sesión"),
  });

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      return d;
    }),
    [weekStart],
  );

  // Convierte la posición del puntero en día + minutos (franjas de 15 min),
  // usando el punto donde el usuario agarró la tarjeta.
  function pointToSlot(clientX: number, clientY: number, grabDy: number) {
    const grid = gridRef.current;
    if (!grid) return null;
    const rect = grid.getBoundingClientRect();
    const colWidth = (rect.width - 72) / 7;
    const dayIndex = Math.min(6, Math.max(0, Math.floor((clientX - rect.left - 72) / colWidth)));
    const topY = clientY - grabDy - rect.top;
    const rawMin = HOURS[0] * 60 + (topY / SLOT_HEIGHT) * 60;
    const snapped = Math.round(rawMin / SLOT_MIN) * SLOT_MIN;
    const minutes = Math.min(
      Math.max(snapped, HOURS[0] * 60),
      (HOURS[HOURS.length - 1] + 1) * 60 - SLOT_MIN,
    );
    return { dayIndex, minutes, colWidth };
  }

  function startDrag(e: React.PointerEvent, a: any) {
    if ((e.target as HTMLElement).closest("button")) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    const cardRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const grabDy = e.clientY - cardRect.top;
    const slot = pointToSlot(e.clientX, e.clientY, grabDy);
    if (!slot) return;
    setDrag({ id: a.id, grabDy, colWidth: slot.colWidth, dayIndex: slot.dayIndex, minutes: slot.minutes, moved: false });
  }

  function startResize(e: React.PointerEvent, a: any, edge: "top" | "bottom") {
    e.preventDefault();
    e.stopPropagation();
    const s = new Date(a.starts_at);
    const en = new Date(a.ends_at);
    setResize({
      id: a.id,
      edge,
      startMin: s.getHours() * 60 + s.getMinutes(),
      endMin: en.getHours() * 60 + en.getMinutes(),
      moved: false,
    });
  }

  useEffect(() => {
    if (!resize) return;
    const onMove = (e: PointerEvent) => {
      const slot = pointToSlot(e.clientX, e.clientY, 0);
      if (!slot) return;
      setResize((r) => {
        if (!r) return r;
        if (r.edge === "top") {
          const startMin = Math.min(slot.minutes, r.endMin - SLOT_MIN);
          return startMin === r.startMin ? r : { ...r, startMin, moved: true };
        }
        const endMin = Math.max(slot.minutes, r.startMin + SLOT_MIN);
        return endMin === r.endMin ? r : { ...r, endMin, moved: true };
      });
    };
    const onUp = () => {
      const cur = resize;
      setResize(null);
      if (!cur?.moved) return;
      const appt = (appts.data ?? []).find((x: any) => x.id === cur.id) as any;
      if (!appt) return;
      const base = new Date(appt.starts_at);
      const starts = new Date(base);
      starts.setHours(Math.floor(cur.startMin / 60), cur.startMin % 60, 0, 0);
      const ends = new Date(base);
      ends.setHours(Math.floor(cur.endMin / 60), cur.endMin % 60, 0, 0);
      moveMut.mutate({ id: cur.id, starts_at: starts.toISOString(), ends_at: ends.toISOString() });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  });

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const slot = pointToSlot(e.clientX, e.clientY, drag.grabDy);
      if (!slot) return;
      setDrag((d) =>
        d
          ? {
              ...d,
              colWidth: slot.colWidth,
              dayIndex: slot.dayIndex,
              minutes: slot.minutes,
              moved: d.moved || slot.dayIndex !== d.dayIndex || slot.minutes !== d.minutes,
            }
          : d,
      );
    };
    const onUp = () => {
      const cur = drag;
      setDrag(null);
      if (!cur?.moved) return;
      const appt = (appts.data ?? []).find((x: any) => x.id === cur.id) as any;
      if (!appt) return;
      const target = new Date(days[cur.dayIndex]);
      target.setHours(Math.floor(cur.minutes / 60), cur.minutes % 60, 0, 0);
      const oldStart = new Date(appt.starts_at);
      const duration = new Date(appt.ends_at).getTime() - oldStart.getTime();
      if (target.getTime() === oldStart.getTime()) return;
      moveMut.mutate({
        id: cur.id,
        starts_at: target.toISOString(),
        ends_at: new Date(target.getTime() + duration).toISOString(),
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  });

  const rangeLabel = useMemo(() => {
    const end = days[6];
    const sameMonth = weekStart.getMonth() === end.getMonth();
    const a = weekStart.toLocaleDateString("es", { day: "numeric", month: sameMonth ? undefined : "short" });
    const b = end.toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" });
    return `${a} — ${b}`;
  }, [days, weekStart]);

  function shiftWeek(delta: number) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + delta * 7);
    setWeekStart(d);
  }

  function toWeekInput(d: Date) {
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dayNum = (t.getDay() + 6) % 7;
    t.setDate(t.getDate() - dayNum + 3);
    const firstThursday = new Date(t.getFullYear(), 0, 4);
    const fDayNum = (firstThursday.getDay() + 6) % 7;
    firstThursday.setDate(firstThursday.getDate() - fDayNum + 3);
    const week = 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * 86400000));
    return `${t.getFullYear()}-W${String(week).padStart(2, "0")}`;
  }

  function fromWeekInput(value: string) {
    const m = /^(\d{4})-W(\d{2})$/.exec(value);
    if (!m) return;
    const year = Number(m[1]);
    const week = Number(m[2]);
    const jan4 = new Date(year, 0, 4);
    const jan4Day = (jan4.getDay() + 6) % 7;
    const monday = new Date(jan4);
    monday.setDate(jan4.getDate() - jan4Day + (week - 1) * 7);
    setWeekStart(startOfWeek(monday));
  }

  const today = new Date();
  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  function openNewAt(d: Date, minutes?: number) {
    const day = new Date(d);
    if (minutes !== undefined) day.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    setPresetDay(day);
    setModal(true);
  }

  function slotRange(d: Date, minutes: number, length = SLOT_MIN) {
    const s = new Date(d);
    s.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    const e = new Date(s.getTime() + length * 60000);
    return { s, e };
  }

  function blocksOverlapping(startsAt: Date, endsAt: Date) {
    return blocks.filter(
      (b) => new Date(b.starts_at) < endsAt && new Date(b.ends_at) > startsAt,
    );
  }

  function isSlotBlocked(d: Date, minutes: number) {
    const { s, e } = slotRange(d, minutes);
    return blocksOverlapping(s, e).length > 0;
  }

  function dayBlocks(d: Date) {
    const s = new Date(d);
    s.setHours(0, 0, 0, 0);
    const e = new Date(s);
    e.setDate(e.getDate() + 1);
    return blocksOverlapping(s, e);
  }

  function isDayFullyBlocked(d: Date) {
    const s = new Date(d);
    s.setHours(0, 0, 0, 0);
    const e = new Date(s);
    e.setDate(e.getDate() + 1);
    return blocks.some((b) => new Date(b.starts_at) <= s && new Date(b.ends_at) >= e);
  }

  function toggleSlotBlock(d: Date, minutes: number) {
    const { s, e } = slotRange(d, minutes);
    const existing = blocksOverlapping(s, e);
    if (existing.length > 0) {
      unblockMut.mutate(existing.map((b) => b.id));
      return;
    }
    blockMut.mutate({ starts_at: s.toISOString(), ends_at: e.toISOString(), kind: "franja", reason: "Horario no disponible" });
  }

  function toggleDayBlock(d: Date) {
    const existing = dayBlocks(d);
    if (existing.length > 0) {
      unblockMut.mutate(existing.map((b) => b.id));
      return;
    }
    const s = new Date(d);
    s.setHours(0, 0, 0, 0);
    const e = new Date(s);
    e.setDate(e.getDate() + 1);
    blockMut.mutate({ starts_at: s.toISOString(), ends_at: e.toISOString(), kind: "dia", reason: "Día no disponible" });
  }

  const bookingSlug = tenant.business?.slug ?? null;
  const bookingUrl =
    typeof window !== "undefined" && bookingSlug ? `${window.location.origin}/booking/${bookingSlug}` : "";



  return (
    <div className="p-4 md:p-8 max-w-[1400px]">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="font-serif text-3xl md:text-4xl">Agenda</h1>
          <div className="mt-1 flex items-center gap-3 flex-wrap">
            <p className="text-muted-foreground capitalize">{rangeLabel}</p>
            <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
              <span className="sr-only">Buscar semana</span>
              <div className="inline-flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => shiftWeek(-1)}
                  className="p-1.5 rounded-lg border border-border hover:bg-secondary"
                  aria-label="Semana anterior"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <input
                  type="week"
                  value={toWeekInput(weekStart)}
                  onChange={(e) => fromWeekInput(e.target.value)}
                  className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground"
                  aria-label="Buscar semana"
                />
                <button
                  type="button"
                  onClick={() => shiftWeek(1)}
                  className="p-1.5 rounded-lg border border-border hover:bg-secondary"
                  aria-label="Semana siguiente"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </label>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => shiftWeek(-1)} className="p-2 rounded-lg border border-border hover:bg-secondary" aria-label="Semana anterior"><ChevronLeft className="h-4 w-4" /></button>
          <button onClick={() => setWeekStart(startOfWeek(new Date()))} className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-secondary">Hoy</button>
          <button onClick={() => shiftWeek(1)} className="p-2 rounded-lg border border-border hover:bg-secondary" aria-label="Semana siguiente"><ChevronRight className="h-4 w-4" /></button>
          <BackupButtons />

          <button onClick={() => { setPresetDay(null); setModal(true); }} className="ml-2 inline-flex items-center gap-2 rounded-full bg-primary text-primary-foreground px-4 py-2 text-sm font-medium">
            <Plus className="h-4 w-4" /> Nueva cita
          </button>
        </div>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        Consejo: arrastra una cita y suéltala en otro día u hora para reagendarla automáticamente. Usa el candado de cada
        franja (o “Bloquear día”) para reservar espacios: lo que bloquees desaparece al instante del enlace de reservas.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-4 py-3">
        <Link2 className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Enlace de reservas para clientes</span>
        {bookingUrl ? (
          <>
            <code className="truncate rounded bg-secondary px-2 py-1 text-xs">{bookingUrl}</code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(bookingUrl);
                toast.success("Enlace copiado");
              }}
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs hover:bg-secondary"
            >
              <Copy className="h-3.5 w-3.5" /> Copiar
            </button>
            <a
              href={`https://wa.me/?text=${encodeURIComponent(`Hola! Puedes reservar tu cita aquí: ${bookingUrl}`)}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full bg-[#25D366] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
            >
              <MessageCircle className="h-3.5 w-3.5" /> Enviar por WhatsApp
            </a>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">Configura tu negocio en Ajustes para generar el enlace.</span>
        )}
      </div>

      {pendingOnline.length > 0 && (
        <div className="mt-4 rounded-2xl border border-sky-500/40 bg-sky-500/5 p-4">
          <h2 className="font-serif text-xl">Reservas online por confirmar ({pendingOnline.length})</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Estas citas llegaron desde tu enlace de reservas. Confírmalas o recházalas; el horario se libera al rechazar.
          </p>
          <div className="mt-3 space-y-2">
            {pendingOnline.map((a: any) => {
              const start = new Date(a.starts_at);
              const phone = (a.client?.whatsapp || a.client?.phone) as string | undefined;
              return (
                <div
                  key={a.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{a.client?.full_name ?? "Cliente"}</div>
                    <div className="text-xs text-muted-foreground">
                      {start.toLocaleDateString("es", { weekday: "short", day: "numeric", month: "short" })} ·{" "}
                      {start.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}
                      {a.service?.name ? ` · ${a.service.name}` : ""}
                      {phone ? ` · ${phone}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => statusMut.mutate({ id: a.id, status: "scheduled" })}
                      disabled={statusMut.isPending}
                      className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
                    >
                      <Check className="h-3.5 w-3.5" /> Confirmar
                    </button>
                    <button
                      type="button"
                      onClick={() => statusMut.mutate({ id: a.id, status: "cancelled" })}
                      disabled={statusMut.isPending}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs hover:bg-secondary"
                    >
                      <X className="h-3.5 w-3.5" /> Rechazar
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}




      <div className="mt-6 rounded-2xl overflow-x-auto border border-[#2a2320] bg-[#1a1512] text-neutral-100 shadow-lg">
        <div className="min-w-[820px]">
        {/* Header row */}
        <div className="grid" style={{ gridTemplateColumns: `72px repeat(7, minmax(0,1fr))` }}>
          <div className="border-b border-r border-white/5" />
          {days.map((d, i) => {
            const active = isSameDay(d, today);
            const dayBlocked = isDayFullyBlocked(d);
            return (
              <div key={i} className="border-b border-white/5 py-3 text-center">
                <div className="text-[11px] uppercase tracking-wider text-neutral-400">{DAY_NAMES[i]}</div>
                <div className={`mt-1 mx-auto w-9 h-9 flex items-center justify-center rounded-full text-lg font-medium ${active ? "bg-primary text-primary-foreground" : "text-neutral-100"}`}>
                  {d.getDate()}
                </div>
                <button
                  type="button"
                  onClick={() => toggleDayBlock(d)}
                  className={`mt-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition ${
                    dayBlocked
                      ? "bg-rose-500 text-white hover:bg-rose-600"
                      : "border border-white/15 text-neutral-300 hover:bg-white/10"
                  }`}
                  title={dayBlocked ? "Día bloqueado — toca para liberar" : "Bloquear día completo"}
                >
                  {dayBlocked ? <LockOpen className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
                  {dayBlocked ? "Liberar día" : "Bloquear día"}
                </button>
              </div>
            );
          })}

        </div>

        {/* Body grid */}
        <div ref={gridRef} className="relative grid" style={{ gridTemplateColumns: `72px repeat(7, minmax(0,1fr))` }}>
          {/* Franjas de 15 minutos */}
          <div className="border-r border-white/5">
            {SLOTS.map((m) => (
              <div
                key={m}
                style={{ height: SLOT_PX }}
                className={`text-[10px] text-right pr-2 leading-[22px] border-b border-white/5 ${m % 60 === 0 ? "text-neutral-300 font-medium" : "text-neutral-500"}`}
              >
                {fmtSlot(m)}
              </div>
            ))}
          </div>

          {/* Day columns */}
          {days.map((d, di) => {
            const dayAppts = (appts.data ?? []).filter((a) => isSameDay(new Date(a.starts_at), d));
            return (
              <div key={di} className="relative border-r border-white/5 last:border-r-0">
                {SLOTS.map((m) => {
                  const blocked = isSlotBlocked(d, m);
                  const taken = dayAppts.some((a) => {
                    const s = new Date(a.starts_at);
                    const e = new Date(a.ends_at);
                    const sm = s.getHours() * 60 + s.getMinutes();
                    const em = e.getHours() * 60 + e.getMinutes();
                    return m < em && m + SLOT_MIN > sm;
                  });
                  return (
                    <div key={m} style={{ height: SLOT_PX }} className="relative group/slot">
                      <button
                        onClick={() => (blocked ? toggleSlotBlock(d, m) : openNewAt(d, m))}
                        style={{ height: SLOT_PX }}
                        aria-label={blocked ? `Liberar franja ${fmtSlot(m)}` : `Nueva cita ${fmtSlot(m)}`}
                        className={`w-full block transition border-b ${m % 60 === 0 ? "border-white/10" : "border-white/[0.04]"} ${
                          blocked
                            ? "bg-[repeating-linear-gradient(45deg,rgba(244,63,94,0.35)_0_6px,transparent_6px_12px)] hover:bg-rose-500/30"
                            : "hover:bg-white/[0.06]"
                        }`}
                      />
                      {!taken && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleSlotBlock(d, m);
                          }}
                          className={`absolute right-0.5 top-0.5 z-10 rounded p-0.5 transition ${
                            blocked
                              ? "bg-rose-500 text-white opacity-100"
                              : "bg-white/15 text-neutral-100 opacity-0 group-hover/slot:opacity-100"
                          }`}
                          aria-label={blocked ? `Liberar franja ${fmtSlot(m)}` : `Bloquear franja ${fmtSlot(m)}`}
                          title={blocked ? "Franja bloqueada — toca para liberar" : "Bloquear esta franja"}
                        >
                          {blocked ? <LockOpen className="h-2.5 w-2.5" /> : <Lock className="h-2.5 w-2.5" />}
                        </button>
                      )}
                    </div>
                  );
                })}

                {dayAppts.map((a) => {
                  const start = new Date(a.starts_at);
                  const end = new Date(a.ends_at);
                  const startMin = start.getHours() * 60 + start.getMinutes();
                  const endMin = end.getHours() * 60 + end.getMinutes();
                  const resizing = resize?.id === a.id ? resize : null;
                  const shownStart = resizing ? resizing.startMin : startMin;
                  const shownEnd = resizing ? resizing.endMin : endMin;
                  const top = ((shownStart - HOURS[0] * 60) / 60) * SLOT_HEIGHT;
                  const height = Math.max(28, ((shownEnd - shownStart) / 60) * SLOT_HEIGHT - 2);
                  const color = (a as any).service?.color ?? "#CDB4DB";
                  const phone = ((a as any).client?.whatsapp || (a as any).client?.phone) as string | undefined;
                  const waReminder = phone ? buildWhatsAppReminder(phone, a) : null;
                  const tr =
                    (a.treatment_id
                      ? (treatments.data ?? []).find((t) => t.id === a.treatment_id)
                      : (treatments.data ?? []).find(
                          (t) => t.client_id === (a as any).client_id && t.status === "open",
                        )) ?? null;
                  const trPendingSessions = tr ? Math.max(0, tr.sessions_total - tr.sessions_done) : 0;
                  const trReady = !!tr && tr.status === "open" && tr.balance_cents <= 0;
                  const dragging = drag?.id === a.id && drag.moved;
                  const previewTop = dragging ? ((drag!.minutes - HOURS[0] * 60) / 60) * SLOT_HEIGHT : top;

                  return (
                    <div
                      key={a.id}
                      data-appt-card={a.id}
                      onPointerDown={(e) => startDrag(e, a)}
                      className={`absolute left-1 right-1 rounded-md p-1.5 pr-9 text-[11px] leading-tight overflow-visible group cursor-grab active:cursor-grabbing touch-none select-none ${dragging ? "z-40 shadow-2xl ring-2 ring-white/70" : ""}`}
                      style={{
                        top,
                        height,
                        background: color,
                        color: readableText(color),
                        transform: dragging
                          ? `translate(${(drag!.dayIndex - di) * drag!.colWidth}px, ${previewTop - top}px)`
                          : undefined,
                      }}
                      title={`${(a as any).client?.full_name} — ${(a as any).service?.name ?? ""}`}
                    >
                      {dragging && (
                        <div className="absolute -top-5 left-0 rounded bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground shadow">
                          {DAY_NAMES[drag!.dayIndex]} {fmtSlot(drag!.minutes)}
                        </div>
                      )}
                      {resizing && (
                        <div className="absolute -top-5 left-0 rounded bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground shadow">
                          {fmtSlot(shownStart)} – {fmtSlot(shownEnd)}
                        </div>
                      )}
                      <div
                        onPointerDown={(e) => startResize(e, a, "top")}
                        className="absolute left-0 right-0 -top-1 h-2.5 cursor-ns-resize touch-none"
                        title="Arrastra para cambiar la hora de inicio"
                      >
                        <div className="mx-auto mt-1 h-0.5 w-8 rounded-full bg-foreground/30 opacity-0 group-hover:opacity-100" />
                      </div>
                      <div
                        onPointerDown={(e) => startResize(e, a, "bottom")}
                        className="absolute left-0 right-0 -bottom-1 h-2.5 cursor-ns-resize touch-none z-30"
                        title="Arrastra para cambiar la hora final"
                      >
                        <div className="mx-auto mt-1 h-0.5 w-8 rounded-full bg-foreground/30 opacity-0 group-hover:opacity-100" />
                      </div>
                      <div className="font-semibold truncate">{(a as any).client?.full_name}</div>
                      <div className="opacity-80 line-clamp-2">{(a as any).service?.name ?? "Cita"}</div>
                      {tr && (
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          <span className="rounded bg-foreground/10 px-1 py-[1px] text-[10px] font-medium">
                            {tr.sessions_done}/{tr.sessions_total} ses · {trPendingSessions} pend
                          </span>
                          <span
                            className={`rounded px-1 py-[1px] text-[10px] font-semibold ${tr.balance_cents > 0 ? "bg-amber-500 text-black" : "bg-emerald-500 text-white"}`}
                            title="Saldo pendiente por pagar"
                          >
                            {tr.balance_cents > 0 ? formatMoney(tr.balance_cents, tenant.currency) : "Pagado"}
                          </span>
                        </div>
                      )}
                      <div className="absolute top-1 right-1 z-20 flex flex-col gap-1">
                        {tr && a.status !== "cancelled" && (
                          <Button
                            type="button"
                            size="icon"
                            onClick={(e) => {
                              e.stopPropagation();
                              completeApptMut.mutate({ id: a.id, completed: a.status !== "completed" });
                            }}
                            onPointerDown={(e) => e.stopPropagation()}
                            className={`h-7 w-7 rounded-full shadow-md ring-2 ring-background transition ${
                              a.status === "completed"
                                ? "bg-emerald-500 text-white hover:bg-emerald-600"
                                : "bg-white/90 text-emerald-700 hover:bg-emerald-100"
                            }`}
                            aria-label={a.status === "completed" ? "Sesión realizada (deshacer)" : "Marcar sesión como realizada"}
                            title={a.status === "completed" ? "Sesión realizada (deshacer)" : "Marcar sesión como realizada"}
                          >
                            {a.status === "completed" ? <CheckCircle2 className="h-4 w-4" /> : <Check className="h-4 w-4" />}
                          </Button>
                        )}
                        {trReady && (
                          <Button
                            type="button"
                            size="icon"
                            onClick={(e) => {
                              e.stopPropagation();
                              closeTreatMut.mutate({ id: tr!.id });
                            }}
                            onPointerDown={(e) => e.stopPropagation()}
                            className="h-7 w-7 rounded-full bg-emerald-500 text-white shadow-md ring-2 ring-background hover:bg-emerald-600"
                            aria-label="Finalizar tratamiento"
                            title="Tratamiento pagado — finalizar"
                          >
                            <CheckCircle2 className="h-4 w-4" />
                          </Button>
                        )}

                        <Button
                          type="button"
                          size="icon"
                          variant="secondary"
                          onClick={(e) => { e.stopPropagation(); setEditAppt(a); }}
                          onPointerDown={(e) => e.stopPropagation()}
                          className="h-7 w-7 rounded-full shadow-md ring-2 ring-background"
                          aria-label="Editar horario de la cita"
                          title="Editar hora de inicio y fin"
                        >
                          <Clock className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (waReminder) {
                              setReminder(waReminder);
                              return;
                            }
                            toast.error("Añade un teléfono al cliente para enviar el recordatorio");
                          }}
                          className="h-7 w-7 rounded-full bg-accent text-accent-foreground shadow-md ring-2 ring-background hover:bg-accent/90"
                          aria-label={`Enviar recordatorio de ${(a as any).client?.full_name ?? "la cita"} por WhatsApp`}
                          title={waReminder ? "Enviar recordatorio por WhatsApp" : "El cliente no tiene teléfono registrado"}
                        >
                          <MessageCircle className="h-4 w-4" />
                        </Button>
                        <button
                          onClick={(e) => { e.stopPropagation(); deleteMut.mutate(a.id); }}
                          className="self-end p-0.5 rounded bg-foreground/20 opacity-0 hover:bg-foreground/40 group-hover:opacity-100"
                          aria-label={`Eliminar cita de ${(a as any).client?.full_name ?? "cliente"}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        </div>
      </div>

      {/* Lista de citas de la semana con recordatorio WhatsApp */}
      <div className="mt-8">
        <h2 className="font-serif text-2xl">Recordatorios de WhatsApp</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Envía el recordatorio de cita a cada cliente por WhatsApp (Web, Escritorio o copiando el mensaje).
        </p>
        <div className="mt-4 space-y-2">
          {(appts.data ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">No hay citas esta semana.</p>
          )}
          {[...(appts.data ?? [])]
            .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())
            .map((a) => {
              const phone = ((a as any).client?.whatsapp || (a as any).client?.phone) as string | undefined;
              const rem = phone ? buildWhatsAppReminder(phone, a) : null;
              const start = new Date(a.starts_at);
              const tr =
                (a.treatment_id
                  ? (treatments.data ?? []).find((t) => t.id === a.treatment_id)
                  : (treatments.data ?? []).find(
                      (t) => t.client_id === (a as any).client_id && t.status === "open",
                    )) ?? null;
              const trPending = tr ? Math.max(0, tr.sessions_total - tr.sessions_done) : 0;
              return (
                <div
                  key={a.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{(a as any).client?.full_name ?? "Cliente"}</div>
                    <div className="text-xs text-muted-foreground">
                      {start.toLocaleDateString("es", { weekday: "short", day: "numeric", month: "short" })} ·{" "}
                      {start.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}
                      {(a as any).service?.name ? ` · ${(a as any).service.name}` : ""}
                    </div>
                    {tr && (
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                        <span className="rounded-full bg-secondary px-2 py-0.5">
                          {tr.sessions_done}/{tr.sessions_total} sesiones · {trPending} pendientes
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 font-semibold ${tr.balance_cents > 0 ? "bg-amber-500/20 text-amber-600" : "bg-emerald-500/20 text-emerald-600"}`}
                        >
                          {tr.balance_cents > 0
                            ? `Saldo ${formatMoney(tr.balance_cents, tenant.currency)}`
                            : "Todo pagado"}
                        </span>
                        {a.status !== "cancelled" && (
                          <button
                            type="button"
                            onClick={() => completeApptMut.mutate({ id: a.id, completed: a.status !== "completed" })}
                            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition ${
                              a.status === "completed"
                                ? "bg-emerald-500 text-white hover:bg-emerald-600"
                                : "border border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10"
                            }`}
                          >
                            {a.status === "completed" ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                            {a.status === "completed" ? "Sesión realizada" : "Marcar sesión realizada"}
                          </button>
                        )}
                        {tr.status === "open" && tr.balance_cents <= 0 && (
                          <button
                            type="button"
                            onClick={() => closeTreatMut.mutate({ id: tr.id })}
                            className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-600"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" /> Finalizar tratamiento
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {rem ? (
                    <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setEditAppt(a)}
                      className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm hover:bg-secondary"
                    >
                      <Clock className="h-4 w-4" /> Editar horario
                    </button>
                    <button
                      type="button"
                      onClick={() => setReminder(rem)}
                      className="inline-flex items-center gap-2 rounded-full bg-[#25D366] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
                    >
                      <MessageCircle className="h-4 w-4" /> Enviar recordatorio
                    </button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setEditAppt(a)}
                        className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm hover:bg-secondary"
                      >
                        <Clock className="h-4 w-4" /> Editar horario
                      </button>
                      <span className="text-xs text-muted-foreground">Sin teléfono registrado</span>
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      </div>

      {modal && (
        <NewApptModal
          day={presetDay ?? days[0]}
          clients={clients.data ?? []}
          services={services.data ?? []}
          treatments={treatments.data ?? []}
          canTreatments
          currency={tenant.currency}
          onClose={() => setModal(false)}
          onCreate={async (payload, newClient, newTreatment) => {
            try {
              let clientId = payload.client_id;
              if (newClient) {
                const c = await createCli({ data: newClient });
                clientId = c.id;
                await qc.invalidateQueries({ queryKey: ["clients"] });
              }
              let treatmentId = payload.treatment_id ?? null;
              if (newTreatment) {
                const t = await createTreat({
                  data: {
                    client_id: clientId,
                    service_id: payload.service_id,
                    total_cents: newTreatment.total_cents,
                    sessions_total: newTreatment.sessions_total,
                  },
                });
                treatmentId = (t as any).id;
              }
              await create({ data: { ...payload, client_id: clientId, treatment_id: treatmentId } });
              qc.invalidateQueries({ queryKey: ["appts"] });
              qc.invalidateQueries({ queryKey: ["treatments"] });
              qc.invalidateQueries({ queryKey: ["receivables"] });
              toast.success("Cita creada");
              setModal(false);
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Error");
            }
          }}
        />
      )}

      {reminder && (
        <WhatsAppReminderModal
          reminder={reminder}
          onClose={() => setReminder(null)}
        />
      )}

      {editAppt && (
        <EditTimeModal
          appt={editAppt}
          services={services.data ?? []}
          treatments={treatments.data ?? []}
          currency={tenant.currency}
          onClose={() => setEditAppt(null)}
          onSave={(v) => {
            moveMut.mutate({ id: editAppt.id, ...v });
            setEditAppt(null);
          }}
          onUpdateTreatment={(v) => updateTreatMut.mutate(v)}
          onCloseTreatment={(v) => closeTreatMut.mutate(v)}
          closingTreatment={closeTreatMut.isPending}
        />
      )}
    </div>
  );
}

function toTimeInput(d: Date) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function toDateInput(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function EditTimeModal({
  appt,
  services,
  treatments,
  currency,
  onClose,
  onSave,
  onUpdateTreatment,
  onCloseTreatment,
  closingTreatment,
}: {
  appt: any;
  services: any[];
  treatments: TreatmentSummary[];
  currency: string;
  onClose: () => void;
  onSave: (v: { starts_at: string; ends_at: string; service_id: string | null; price_cents: number | null }) => void;
  onUpdateTreatment: (v: { id: string; total_cents?: number; sessions_total?: number }) => void;
  onCloseTreatment: (v: { id: string; reopen?: boolean }) => void;
  closingTreatment?: boolean;
}) {
  const s = new Date(appt.starts_at);
  const e0 = new Date(appt.ends_at);
  const [date, setDate] = useState(toDateInput(s));
  const [start, setStart] = useState(toTimeInput(s));
  const [end, setEnd] = useState(toTimeInput(e0));
  const [serviceId, setServiceId] = useState<string>(appt.service_id ?? "");

  const linked = appt.treatment_id
    ? treatments.find((t) => t.id === appt.treatment_id) ?? null
    : null;
  const fallback =
    !linked && appt.client_id
      ? treatments.find((t) => t.client_id === appt.client_id && t.status === "open") ?? null
      : null;
  const treatment = linked ?? fallback;
  const [treatTotal, setTreatTotal] = useState(() =>
    linked ? String(linked.total_cents / 100) : "",
  );
  const [treatSessions, setTreatSessions] = useState(() =>
    linked ? String(linked.sessions_total) : "",
  );
  const sessionsPendingNow = treatment
    ? Math.max(
        0,
        (linked ? Number(treatSessions) || treatment.sessions_total : treatment.sessions_total) -
          treatment.sessions_done,
      )
    : 0;
  const state = !treatment
    ? { label: "", pill: "", panel: "border-border bg-card" }
    : treatment.status === "closed"
      ? {
          label: "Finalizado",
          pill: "bg-muted text-muted-foreground",
          panel: "border-border bg-muted/40 opacity-90",
        }
      : treatment.settled && sessionsPendingNow === 0
        ? {
            label: "Listo para finalizar",
            pill: "bg-emerald-500/15 text-emerald-600",
            panel: "border-emerald-500/40 bg-emerald-500/5",
          }
        : {
            label: "En curso",
            pill: "bg-amber-500/15 text-amber-600",
            panel: "border-amber-500/40 bg-amber-500/5",
          };

  const currentService = services.find((x) => x.id === serviceId) ?? null;
  const servicePriceCents = currentService?.price_cents ?? appt.price_cents ?? appt.service?.price_cents ?? null;


  function onServiceChange(id: string) {
    setServiceId(id);
    const svc = services.find((x) => x.id === id);
    if (svc?.duration_min && start) {
      const [h, m] = start.split(":").map(Number);
      const d = new Date();
      d.setHours(h ?? 0, (m ?? 0) + svc.duration_min, 0, 0);
      setEnd(toTimeInput(d));
    }
  }

  return (
    <Modal title="Editar horario de la cita" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(ev) => {
          ev.preventDefault();
          const starts = new Date(`${date}T${start}:00`);
          const ends = new Date(`${date}T${end}:00`);
          if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime())) return;
          if (ends.getTime() <= starts.getTime()) {
            toast.error("La hora final debe ser posterior a la de inicio");
            return;
          }
          const svc = services.find((x) => x.id === serviceId);
          if (linked) {
            const newTotalCents = Math.round((Number(treatTotal) || 0) * 100);
            const newSessions = Math.max(1, Math.round(Number(treatSessions) || 1));
            if (newTotalCents !== linked.total_cents || newSessions !== linked.sessions_total) {
              onUpdateTreatment({
                id: linked.id,
                total_cents: newTotalCents !== linked.total_cents ? newTotalCents : undefined,
                sessions_total: newSessions !== linked.sessions_total ? newSessions : undefined,
              });
            }
          }

          onSave({
            starts_at: starts.toISOString(),
            ends_at: ends.toISOString(),
            service_id: serviceId || null,
            price_cents: svc?.price_cents ?? null,
          });
        }}
      >
        <p className="text-sm text-muted-foreground">
          {appt.client?.full_name ?? "Cliente"}
          {appt.service?.name ? ` · ${appt.service.name}` : ""}
        </p>
        <div className="rounded-xl border border-border bg-secondary/50 p-3 text-sm flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Valor del servicio</span>
          <span className="font-medium">
            {servicePriceCents != null ? formatMoney(servicePriceCents, currency) : "—"}
          </span>
        </div>
        {treatment && (
          <div className={`rounded-xl border p-4 space-y-2 ${state.panel}`}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                Tratamiento{treatment.service_name ? ` · ${treatment.service_name}` : ""}
              </h3>
              <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${state.pill}`}>{state.label}</span>
            </div>
            {!linked && (
              <p className="text-[11px] text-muted-foreground">
                Tratamiento en curso de este cliente (esta cita no está vinculada a él).
              </p>
            )}
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div>
                <label className="text-[11px] uppercase tracking-wide text-muted-foreground">Valor total</label>
                {linked ? (
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={treatTotal}
                    onChange={(e) => setTreatTotal(e.target.value)}
                    className="mt-0.5 w-full rounded-lg border border-input bg-background px-2.5 py-1.5 text-sm font-medium"
                  />
                ) : (
                  <div className="font-medium">{formatMoney(treatment.total_cents, currency)}</div>
                )}
              </div>
              <div>
                <label className="text-[11px] uppercase tracking-wide text-muted-foreground">Sesiones programadas</label>
                {linked ? (
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={treatSessions}
                    onChange={(e) => setTreatSessions(e.target.value)}
                    className="mt-0.5 w-full rounded-lg border border-input bg-background px-2.5 py-1.5 text-sm font-medium"
                  />
                ) : (
                  <div className="font-medium">{treatment.sessions_total}</div>
                )}
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Sesiones realizadas</div>
                <div className="font-medium">{treatment.sessions_done}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Sesiones pendientes</div>
                <div className="font-medium">{sessionsPendingNow}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Valor por sesión</div>
                <div className="font-medium">{formatMoney(treatment.session_price_cents, currency)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Abonos</div>
                <div className="font-medium text-emerald-600">{formatMoney(treatment.paid_cents, currency)}</div>
              </div>
              <div className="col-span-2 border-t border-border pt-2 flex items-center justify-between">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Saldo pendiente por pagar</div>
                <div className={`font-semibold ${treatment.balance_cents > 0 ? "text-amber-600" : "text-emerald-600"}`}>
                  {formatMoney(treatment.balance_cents, currency)}
                </div>
              </div>
            </div>
            {treatment.status === "closed" ? (
              <button
                type="button"
                disabled={closingTreatment}
                onClick={() => onCloseTreatment({ id: treatment.id, reopen: true })}
                className="mt-1 w-full rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-secondary transition disabled:opacity-60"
              >
                Reabrir tratamiento
              </button>
            ) : (
              <button
                type="button"
                disabled={closingTreatment}
                onClick={() => {
                  if (treatment.balance_cents > 0 || sessionsPendingNow > 0) {
                    const msg = [
                      treatment.balance_cents > 0
                        ? `saldo pendiente de ${formatMoney(treatment.balance_cents, currency)}`
                        : null,
                      sessionsPendingNow > 0 ? `${sessionsPendingNow} sesión(es) sin agendar` : null,
                    ]
                      .filter(Boolean)
                      .join(" y ");
                    if (!window.confirm(`Este tratamiento tiene ${msg}. ¿Finalizarlo de todas formas?`)) return;
                  }
                  onCloseTreatment({ id: treatment.id });
                }}
                className={`mt-1 w-full rounded-full px-4 py-2 text-sm font-medium text-white transition disabled:opacity-60 ${
                  treatment.settled && sessionsPendingNow === 0
                    ? "bg-emerald-600 hover:bg-emerald-700"
                    : "bg-amber-600 hover:bg-amber-700"
                }`}
              >
                {closingTreatment ? "Finalizando…" : "Finalizar tratamiento"}
              </button>
            )}
          </div>
        )}

        <div>
          <label className="text-xs text-muted-foreground">Fecha</label>
          <input type="date" value={date} onChange={(ev) => setDate(ev.target.value)} className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground">Hora de inicio</label>
            <input type="time" step={900} value={start} onChange={(ev) => setStart(ev.target.value)} className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Hora final</label>
            <input type="time" step={900} value={end} onChange={(ev) => setEnd(ev.target.value)} className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
          </div>
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Servicio</label>
          <select
            value={serviceId}
            onChange={(ev) => onServiceChange(ev.target.value)}
            className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">Sin servicio</option>
            {services.map((sv) => (
              <option key={sv.id} value={sv.id}>
                {sv.name}
                {sv.price_cents ? ` · $${(sv.price_cents / 100).toLocaleString("es")}` : ""}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-muted-foreground">Añádelo si olvidaste elegirlo al agendar.</p>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-lg border border-border">Cancelar</button>
          <button type="submit" className="px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground">Guardar horario</button>
        </div>
      </form>
    </Modal>
  );
}

function readableText(hex: string) {
  const h = hex.replace("#", "");
  if (h.length !== 6) return "#1a1512";
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 150 ? "#1a1512" : "#f7f2ee";
}

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, "");
  return digits.length >= 7 ? digits : null;
}

type WhatsAppReminder = {
  phone: string;
  clientName: string;
  message: string;
  webUrl: string;
  desktopUrl: string;
};

function buildWhatsAppReminder(phone: string, a: any): WhatsAppReminder | null {
  const num = normalizePhone(phone);
  if (!num) return null;
  const start = new Date(a.starts_at);
  const fecha = start.toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" });
  const hora = start.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
  const nombre = a.client?.full_name ?? "";
  const servicio = a.service?.name ? ` para tu ${a.service.name}` : "";
  const msg =
    `Hola ${nombre} 👋, te recordamos tu cita${servicio} el ${fecha} a las ${hora}. ` +
    `Por favor confírmanos tu asistencia. ¡Gracias!`;
  const encoded = encodeURIComponent(msg);
  return {
    phone: num,
    clientName: nombre || "Paciente",
    message: msg,
    webUrl: `https://web.whatsapp.com/send/?phone=${num}&text=${encoded}&app_absent=0`,
    desktopUrl: `whatsapp://send?phone=${num}&text=${encoded}`,
  };
}

type Client = { id: string; full_name: string };

const WA_WINDOW_NAME = "eleva_whatsapp_web";
let waWindow: Window | null = null;
type Service = { id: string; name: string; duration_min: number; color: string };

function WhatsAppReminderModal({ reminder, onClose }: { reminder: WhatsAppReminder; onClose: () => void }) {
  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(reminder.message);
      toast.success("Recordatorio copiado");
    } catch {
      toast.error("No se pudo copiar el mensaje");
    }
  }

  function openWhatsAppDesktop() {
    // Copy first so the user has the message even if the OS handler is slow.
    void copyMessage();

    // Strategy 1: hidden iframe — the browser hands the custom protocol to the
    // OS without navigating the current page. Works in most browsers even
    // inside an iframe preview (Chrome, Edge, Brave).
    const frame = document.createElement("iframe");
    frame.style.display = "none";
    frame.src = reminder.desktopUrl;
    document.body.appendChild(frame);
    setTimeout(() => frame.remove(), 2000);

    // Strategy 2: also trigger a top-level navigation via an anchor with
    // target="_top" as a fallback for browsers that ignore iframe src for
    // custom schemes (Safari/Firefox). Using _top escapes the preview iframe.
    try {
      const a = document.createElement("a");
      a.href = reminder.desktopUrl;
      a.target = "_top";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      /* ignore */
    }

    setTimeout(onClose, 600);
  }

  function openWhatsAppWeb() {
    // Reuse a single tab for every message: keep the handle around and only
    // change its location instead of opening a new window each time.
    let win = waWindow && !waWindow.closed ? waWindow : null;

    if (win) {
      try {
        win.location.href = reminder.webUrl;
        win.focus();
      } catch {
        win = null;
      }
    }

    if (!win) {
      // The window name keeps the same tab even after a full page reload.
      win = window.open(reminder.webUrl, WA_WINDOW_NAME);
      if (win) {
        waWindow = win;
        win.focus();
      } else {
        const a = document.createElement("a");
        a.href = reminder.webUrl;
        a.target = WA_WINDOW_NAME;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    }

    setTimeout(() => void copyMessage(), 150);
    setTimeout(onClose, 400);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl bg-card p-6 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-serif text-xl">Recordatorio WhatsApp</h3>
            <p className="text-sm text-muted-foreground">{reminder.clientName} · +{reminder.phone}</p>
          </div>
          <button type="button" onClick={onClose} className="p-1" aria-label="Cerrar recordatorio"><X className="h-4 w-4" /></button>
        </div>

        <textarea
          readOnly
          value={reminder.message}
          rows={5}
          className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm"
        />

        <div className="space-y-2">
          <button
            type="button"
            onClick={openWhatsAppWeb}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#25D366] px-3 py-2.5 text-sm font-medium text-white hover:opacity-90"
          >
            <MessageCircle className="h-4 w-4" /> Abrir en WhatsApp Web
          </button>
          <button
            type="button"
            onClick={openWhatsAppDesktop}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-secondary"
          >
            <MessageCircle className="h-4 w-4" /> Abrir en WhatsApp Desktop (app nativa)
          </button>
          <button
            type="button"
            onClick={copyMessage}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-secondary"
          >
            <Copy className="h-4 w-4" /> Copiar mensaje
          </button>
        </div>

        <p className="text-xs text-muted-foreground text-center">
          "Web" reutiliza siempre la misma pestaña de WhatsApp Web. "Desktop" solo funciona si tienes instalada la app nativa de WhatsApp (Microsoft Store / Meta), no la versión web. El mensaje se copia automáticamente como respaldo.
        </p>
      </div>
    </div>
  );
}

function NewApptModal({
  day, clients, services, treatments, canTreatments, currency, onClose, onCreate,
}: {
  day: Date;
  clients: Client[];
  services: Service[];
  treatments: TreatmentSummary[];
  canTreatments: boolean;
  currency: string;
  onClose: () => void;
  onCreate: (
    payload: {
      client_id: string;
      service_id: string | null;
      treatment_id: string | null;
      starts_at: string;
      ends_at: string;
      notes: string | null;
    },
    newClient?: ClientPayload,
    newTreatment?: { total_cents: number; sessions_total: number },
  ) => void;
}) {
  const [clientId, setClientId] = useState("");
  const [newClient, setNewClient] = useState<ClientPayload | null>(null);
  const [clientForm, setClientForm] = useState(false);
  const [serviceId, setServiceId] = useState("");
  const [treatmentId, setTreatmentId] = useState("");
  const [total, setTotal] = useState("");
  const [sessions, setSessions] = useState("");
  const [time, setTime] = useState(() => {
    const h = day.getHours() || 10;
    return `${String(h).padStart(2, "0")}:${String(day.getMinutes()).padStart(2, "0")}`;
  });
  const [endTime, setEndTime] = useState(() => {
    const d = new Date(day);
    if (!d.getHours()) d.setHours(10, 0, 0, 0);
    d.setMinutes(d.getMinutes() + 60);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  });
  const [notes, setNotes] = useState("");

  const openForClient = treatments.filter((t) => t.client_id === clientId && t.status === "open");
  const selected = openForClient.find((t) => t.id === treatmentId) ?? null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const [hh, mm] = time.split(":").map(Number);
    const starts = new Date(day); starts.setHours(hh, mm, 0, 0);
    const [eh, em] = endTime.split(":").map(Number);
    const ends = new Date(day); ends.setHours(eh, em, 0, 0);
    if (ends.getTime() <= starts.getTime()) ends.setTime(starts.getTime() + 60 * 60_000);
    const totalCents = Math.round((Number(total) || 0) * 100);
    const sessionsTotal = Math.max(0, Math.round(Number(sessions) || 0));
    const wantsNew = canTreatments && !treatmentId && totalCents > 0 && sessionsTotal > 0;
    onCreate(
      {
        client_id: clientId,
        service_id: serviceId || null,
        treatment_id: treatmentId || null,
        starts_at: starts.toISOString(),
        ends_at: ends.toISOString(),
        notes: notes || null,
      },
      newClient ?? undefined,
      wantsNew ? { total_cents: totalCents, sessions_total: sessionsTotal } : undefined,
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <form onSubmit={submit} className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-2xl bg-card p-6">
        <div className="flex items-center justify-between pb-4">
          <h3 className="font-serif text-xl">Nueva cita</h3>
          <button type="button" onClick={onClose} className="p-1"><X className="h-4 w-4" /></button>
        </div>
        <div className="grid flex-1 gap-4 overflow-y-auto pr-1 md:grid-cols-2">


        <div>
          <label className="text-xs text-muted-foreground">Cliente existente</label>
          <select
            value={clientId}
            onChange={(e) => {
              const id = e.target.value;
              setClientId(id);
              setNewClient(null);
              const open = treatments.find((t) => t.client_id === id && t.status === "open");
              setTreatmentId(open ? open.id : "");
            }}
            className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">— Ninguno —</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground">…o crear cliente nuevo</label>
          {newClient ? (
            <div className="mt-1 flex items-center justify-between gap-2 rounded-lg border border-input bg-background px-3 py-2 text-sm">
              <span className="truncate">
                {newClient.full_name}
                {newClient.whatsapp ? ` · ${newClient.whatsapp}` : ""}
              </span>
              <div className="flex items-center gap-2 shrink-0">
                <button type="button" className="text-xs underline" onClick={() => setClientForm(true)}>Editar</button>
                <button type="button" className="text-xs underline text-destructive" onClick={() => setNewClient(null)}>Quitar</button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setClientForm(true)}
              className="mt-1 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-input px-3 py-2 text-sm hover:bg-secondary"
            >
              <Plus className="h-4 w-4" /> Nuevo cliente (formulario completo)
            </button>
          )}
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Servicio</label>
          <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm">
            <option value="">— Sin servicio —</option>
            {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>

        {canTreatments && (
          <div className="rounded-xl border border-border p-3 space-y-3 md:col-span-2">

            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Tratamiento</span>
              <span className="rounded-full bg-primary/10 text-primary text-[10px] px-2 py-0.5 font-semibold">PRO</span>
            </div>

            {openForClient.length > 0 && (
              <div>
                <label className="text-xs text-muted-foreground">Tratamiento en curso del cliente</label>
                <select
                  value={treatmentId}
                  onChange={(e) => setTreatmentId(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">— Crear uno nuevo —</option>
                  {openForClient.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.service_name} · saldo {formatMoney(t.balance_cents, currency)} · {t.sessions_remaining} sesiones
                    </option>
                  ))}
                </select>
              </div>
            )}

            {selected ? (
              <div className="rounded-lg bg-secondary p-3 text-xs space-y-2">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <div>
                    Valor del servicio
                    <div className="font-medium text-foreground">{formatMoney(selected.total_cents, currency)}</div>
                  </div>
                  <div>
                    Valor por sesión
                    <div className="font-medium text-foreground">{formatMoney(selected.session_price_cents, currency)}</div>
                  </div>
                  <div>
                    Abonos
                    <div className="font-medium text-emerald-600">{formatMoney(selected.paid_cents, currency)}</div>
                  </div>
                  <div>
                    Sesiones agendadas
                    <div className="font-medium text-foreground">
                      {selected.sessions_scheduled} de {selected.sessions_total}
                    </div>
                  </div>
                  <div>
                    Sesiones pendientes
                    <div className="font-medium text-foreground">
                      {Math.max(0, selected.sessions_total - selected.sessions_scheduled)}
                      {" → "}
                      <span className="text-primary">
                        {Math.max(0, selected.sessions_total - selected.sessions_scheduled - 1)} tras esta cita
                      </span>
                    </div>
                  </div>
                  <div>
                    Estado
                    <div className="font-medium text-foreground">{selected.settled ? "A paz y salvo" : "Con saldo"}</div>
                  </div>
                </div>
                <div className="flex items-center justify-between border-t border-border pt-2">
                  <span>Saldo pendiente por pagar</span>
                  <span className={`font-semibold ${selected.balance_cents > 0 ? "text-destructive" : "text-emerald-600"}`}>
                    {formatMoney(selected.balance_cents, currency)}
                  </span>
                </div>
              </div>
            ) : (

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground">Valor total del tratamiento</label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={total}
                    onChange={(e) => setTotal(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Sesiones a pagar</label>
                  <input
                    type="number"
                    min={1}
                    step="1"
                    value={sessions}
                    onChange={(e) => setSessions(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                  />
                </div>
                <p className="col-span-2 text-[11px] text-muted-foreground">
                  Los abonos registrados en Pagos descuentan el saldo y las sesiones de este tratamiento.
                </p>
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 md:col-span-2">
          <div>
            <label className="text-xs text-muted-foreground">Hora de inicio</label>
            <input type="time" step={900} value={time} onChange={(e) => setTime(e.target.value)} className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Hora final</label>
            <input type="time" step={900} value={endTime} onChange={(e) => setEndTime(e.target.value)} className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
          </div>
        </div>
        <div className="md:col-span-2">
          <label className="text-xs text-muted-foreground">Notas</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
        </div>
        </div>
        <div className="mt-4 flex gap-2 justify-end border-t border-border pt-4">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-lg border border-border">Cancelar</button>
          <button
            type="submit"
            disabled={!clientId && !newClient}
            className="px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground disabled:opacity-60"
          >
            Crear cita
          </button>
        </div>

      </form>

      {clientForm && (
        <Modal title="Nuevo cliente" onClose={() => setClientForm(false)} wide>
          <ClientForm
            client={newClient}
            submitLabel="Usar este cliente"
            onCancel={() => setClientForm(false)}
            onSave={(payload) => {
              setNewClient(payload);
              setClientId("");
              setClientForm(false);
            }}
          />
        </Modal>
      )}
    </div>
  );
}
