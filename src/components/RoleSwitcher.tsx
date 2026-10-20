import React from 'react';

export type Role = 'owner' | 'agent' | 'vendor';

interface Props {
  role: Role;
  onChange: (r: Role) => void;
}

const roles: { id: Role; label: string; description: string }[] = [
  { id: 'owner', label: 'Owner', description: 'Create & manage vaults' },
  { id: 'agent', label: 'Agent', description: 'View & claim budget' },
  { id: 'vendor', label: 'Vendor', description: 'View incoming payments' },
];

export function RoleSwitcher({ role, onChange }: Props) {
  return (
    <div className="flex gap-1 p-1 rounded-xl bg-[var(--surface-muted)] border border-[var(--border)]">
      {roles.map((r) => (
        <button
          key={r.id}
          onClick={() => onChange(r.id)}
          className={[
            'flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]',
            role === r.id
              ? 'bg-[var(--accent)] text-white shadow-sm'
              : 'text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface)]',
          ].join(' ')}
          title={r.description}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}
