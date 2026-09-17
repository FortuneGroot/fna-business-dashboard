import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { PageHead, Card, MetricTile, DataTable } from "@/components/ui";

const METRICS = [
  { label: "Outstanding Invoices", value: "—", note: "Total open invoice balance across all contacts." },
  { label: "Paid This Month", value: "—", note: "Payments collected in the current calendar month." },
  { label: "Overdue", value: "—", note: "Invoices past their due date and unpaid." },
];

export default function PaymentsPage() {
  return (
    <AppShell>
      <PageHead
        title="Payments"
        description="Invoices and payment status for your contacts. Figures stay blank until payment processing is connected — nothing here is estimated."
      />

      <StatusBanner>
        Payment processing is not yet connected for this account. No invoices, balances, or payment
        history can appear here until it is set up.
      </StatusBanner>

      <div className="grid grid-3" style={{ marginTop: "1.1rem" }}>
        {METRICS.map((m) => (
          <MetricTile key={m.label} label={m.label} value={m.value} note={m.note} />
        ))}
      </div>

      <div style={{ marginTop: "1.1rem" }}>
        <Card title="Invoices">
          <DataTable
            columns={["Invoice", "Contact", "Amount", "Status", "Due Date"]}
            rows={[]}
            emptyTitle="No invoices yet"
            emptyNote="Invoices will appear here once payment processing is connected and the first invoice is created."
          />
        </Card>
      </div>
    </AppShell>
  );
}
