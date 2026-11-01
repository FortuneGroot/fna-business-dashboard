"use client";

import { useEffect, useState } from "react";
import { api, type Member } from "@/lib/ui/native-api";

type Option = { id: string; name: string };

/** Contact chooser: searches /api/contacts in this workspace as the user types. */
export function ContactPicker({
  id,
  value,
  onChange,
  initialName,
  optional = false,
}: {
  id: string;
  value: string;
  onChange: (contactId: string) => void;
  initialName?: string | null;
  optional?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Option[]>(value && initialName ? [{ id: value, name: initialName }] : []);

  useEffect(() => {
    const timer = setTimeout(async () => {
      const params = new URLSearchParams({ limit: "20" });
      if (query.trim()) params.set("q", query.trim());
      const { body } = await api(`/api/contacts?${params}`);
      if (body.ok && Array.isArray(body.items)) {
        const found = (body.items as { id: string; name: string }[]).map((c) => ({ id: c.id, name: c.name }));
        setOptions((prev) => {
          const current = prev.find((o) => o.id === value);
          return current && !found.some((o) => o.id === value) ? [current, ...found] : found;
        });
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query, value]);

  return (
    <div>
      <label htmlFor={`${id}-search`}>Find a contact</label>
      <input id={`${id}-search`} type="search" placeholder="Name, email, or phone" value={query} onChange={(e) => setQuery(e.target.value)} />
      <label htmlFor={id}>Contact</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} required={!optional}>
        <option value="">{optional ? "No contact" : "Choose a contact"}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </select>
    </div>
  );
}

export function MemberSelect({
  id,
  label,
  value,
  members,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  members: Member[];
  onChange: (userId: string) => void;
}) {
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Unassigned</option>
        {members.map((m) => (
          <option key={m.userId} value={m.userId}>{m.name || m.email}</option>
        ))}
      </select>
    </>
  );
}
