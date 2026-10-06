import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import {
  Activity,
  BookOpen,
  KeyRound,
  LifeBuoy,
  Mail,
  MessageCircle,
  Phone,
  PlugZap,
  Radar,
} from "lucide-react";
import { AppShell } from "@/components/app/AppShell";
import { PageHeader, Section } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getSupportSettings, saveSupportSettings, type SupportSettings } from "@/lib/support.functions";

export const Route = createFileRoute("/_authenticated/support")({
  head: () => ({
    meta: [
      { title: "Support & Help — Seovale" },
      {
        name: "description",
        content:
          "Find help with scans, reports, integrations and licensing, and see where to check live system status.",
      },
      { property: "og:title", content: "Support & Help — Seovale" },
      {
        property: "og:description",
        content: "Help topics and live status for your Seovale workspace.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SupportPage,
});

const topics = [
  {
    to: "/scans" as const,
    icon: Radar,
    title: "Run a website scan",
    body: "Enter a website address and Seovale collects live data, then builds findings, evidence and a CSV export.",
  },
  {
    to: "/settings" as const,
    icon: PlugZap,
    title: "Connect a platform",
    body: "Add keys or sign in to a platform in the integration manager. Each connection is tested against the real provider before it is marked connected.",
  },
  {
    to: "/reports" as const,
    icon: BookOpen,
    title: "Reports and exports",
    body: "Every report and CSV is built from stored scan data only, so numbers always match what was actually collected.",
  },
  {
    to: "/licensing" as const,
    icon: KeyRound,
    title: "Licences and downloads",
    body: "Issue or renew a licence, lock it to a domain, and download a signed package after two-factor confirmation.",
  },
  {
    to: "/system" as const,
    icon: Activity,
    title: "Check live status",
    body: "System health shows the real state of the database, scan engine, queue, AI providers and integrations.",
  },
];

function SupportPage() {
  return (
    <AppShell>
      <PageHeader
        eyebrow="Help"
        title="Support"
        description="Guides for the main workflows, plus where to check what the system is doing right now."
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {topics.map((topic) => (
          <Link
            key={topic.to}
            to={topic.to}
            className="card-elevated card-interactive surface-sheen flex flex-col gap-2 p-4"
          >
            <span className="icon-tile grid size-9 place-items-center">
              <topic.icon className="size-4" />
            </span>
            <h3 className="font-display text-sm font-bold">{topic.title}</h3>
            <p className="text-xs leading-relaxed text-muted-foreground">{topic.body}</p>
          </Link>
        ))}
      </div>

      <ContactChannels />
    </AppShell>
  );
}

const FIELDS = [
  { key: "supportName", label: "Support team name", placeholder: "Seovale support" },
  { key: "phone", label: "Phone number", placeholder: "+91 …" },
  { key: "whatsapp", label: "WhatsApp number", placeholder: "+91 …" },
  { key: "email", label: "Support inbox", placeholder: "help@example.com" },
  { key: "hours", label: "Support hours", placeholder: "Mon–Fri, 9am–6pm IST" },
  { key: "helpUrl", label: "Help centre link", placeholder: "https://…" },
] as const;

function ContactChannels() {
  const queryClient = useQueryClient();
  const load = useServerFn(getSupportSettings);
  const save = useServerFn(saveSupportSettings);
  const { data, isLoading } = useQuery({ queryKey: ["support-settings"], queryFn: () => load() });
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});

  const mutation = useMutation({
    mutationFn: (values: SupportSettings) => save({ data: values }),
    onSuccess: () => {
      toast.success("Support details saved");
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: ["support-settings"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const start = () => {
    setForm({
      supportName: data?.supportName ?? "",
      phone: data?.phone ?? "",
      whatsapp: data?.whatsapp ?? "",
      email: data?.email ?? "",
      hours: data?.hours ?? "",
      helpUrl: data?.helpUrl ?? "",
      defaultMessage: data?.defaultMessage ?? "",
    });
    setEditing(true);
  };

  const channels = [
    data?.phone ? { icon: Phone, label: "Call", value: data.phone, href: `tel:${data.phone}` } : null,
    data?.whatsapp
      ? {
          icon: MessageCircle,
          label: "WhatsApp",
          value: data.whatsapp,
          href: `https://wa.me/${data.whatsapp.replace(/[^\d]/g, "")}${
            data.defaultMessage ? `?text=${encodeURIComponent(data.defaultMessage)}` : ""
          }`,
        }
      : null,
    data?.email ? { icon: Mail, label: "Email", value: data.email, href: `mailto:${data.email}` } : null,
    data?.helpUrl
      ? { icon: BookOpen, label: "Help centre", value: data.helpUrl, href: data.helpUrl }
      : null,
  ].filter(Boolean) as { icon: typeof Phone; label: string; value: string; href: string }[];

  return (
    <Section
      className="mt-4"
      title="Contact channels"
      description={
        isLoading
          ? "Loading saved support details…"
          : data?.hours
            ? `Support hours: ${data.hours}`
            : "Only the details saved here are shown — nothing is invented."
      }
      action={
        <Button variant="outline" size="sm" onClick={editing ? () => setEditing(false) : start}>
          {editing ? "Cancel" : channels.length > 0 ? "Edit details" : "Add details"}
        </Button>
      }
    >
      {editing ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {FIELDS.map((field) => (
            <label key={field.key} className="flex flex-col gap-1.5 text-xs font-medium">
              {field.label}
              <Input
                value={form[field.key] ?? ""}
                placeholder={field.placeholder}
                onChange={(e) => setForm((prev) => ({ ...prev, [field.key]: e.target.value }))}
              />
            </label>
          ))}
          <label className="flex flex-col gap-1.5 text-xs font-medium sm:col-span-2">
            Default WhatsApp message
            <Input
              value={form["defaultMessage"] ?? ""}
              placeholder="Hi, I need help with my Seovale account"
              onChange={(e) => setForm((prev) => ({ ...prev, defaultMessage: e.target.value }))}
            />
          </label>
          <div className="sm:col-span-2">
            <Button
              size="sm"
              disabled={mutation.isPending}
              onClick={() =>
                mutation.mutate({
                  supportName: form["supportName"] ?? null,
                  phone: form["phone"] ?? null,
                  whatsapp: form["whatsapp"] ?? null,
                  email: form["email"] ?? null,
                  hours: form["hours"] ?? null,
                  helpUrl: form["helpUrl"] ?? null,
                  defaultMessage: form["defaultMessage"] ?? null,
                })
              }
            >
              {mutation.isPending ? "Saving…" : "Save support details"}
            </Button>
          </div>
        </div>
      ) : channels.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {channels.map((channel) => (
            <a
              key={channel.label}
              href={channel.href}
              className="card-elevated card-interactive flex items-center gap-3 p-3"
            >
              <span className="icon-tile grid size-9 shrink-0 place-items-center">
                <channel.icon className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-xs text-muted-foreground">{channel.label}</span>
                <span className="block truncate text-sm font-semibold">{channel.value}</span>
              </span>
            </a>
          ))}
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <span className="icon-tile grid size-9 shrink-0 place-items-center">
            <LifeBuoy className="size-4" />
          </span>
          <p className="text-sm text-muted-foreground">
            No support phone, WhatsApp or inbox has been saved yet. Add the real details and they appear
            here as working call, chat and email buttons.
          </p>
        </div>
      )}
    </Section>
  );
}
