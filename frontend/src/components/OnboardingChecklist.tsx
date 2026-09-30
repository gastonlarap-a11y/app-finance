import { useState } from 'react'
import { useSetAtom } from 'jotai'
import { Circle, CircleCheck, Rocket, X } from 'lucide-react'
import { quickAddAtom } from '@/atoms/finance'
import { useVersion } from '@/atoms/refresh'
import { FinanceService } from '@/services/finance'
import { SettingsService } from '@/services/settings'
import { lastExport } from '@/lib/exportFile'
import { currentPeriod } from '@/lib/format'
import { isZero } from '@/lib/money'
import { dismissKey, onboardingDone, onboardingSteps, type OnboardingFacts } from '@/lib/onboarding'
import { IS_WEB } from '@/lib/platform'
import { useQuery } from '@/lib/useQuery'
import { Bar, Button, IconButton } from './ui'
import { Link } from './Link'
import { useProfiles } from './shell/profiles'

// useOnboardingFacts reads what the guide checks from the regular services;
// null while loading (the guide never flashes in).
function useOnboardingFacts(): OnboardingFacts | null {
  const version = useVersion('ledger', 'settings', 'profiles')
  const query = useQuery(`onboarding:${version}`, async (): Promise<OnboardingFacts> => {
    const period = currentPeriod()
    const [cards, accounts, categories, summary, search, settings] = await Promise.all([
      FinanceService.ListCards(),
      FinanceService.ListAccounts(period),
      FinanceService.ListCategories(),
      FinanceService.MonthlySummary(period),
      FinanceService.SearchExpenses({ text: '', category: '', tag: '', cardId: null, fromPeriod: '', toPeriod: '', limit: 1, offset: 0 }),
      IS_WEB ? Promise.resolve(null) : SettingsService.GetState(),
    ])
    return {
      cardsOrAccounts: cards.length + (accounts.data?.accounts.length ?? 0),
      categories: categories.length,
      incomeThisMonth: !!summary.data && !isZero(summary.data.ingresos),
      anyExpense: (search.data?.count ?? 0) > 0,
      openingBalance: !!summary.data && (summary.data.acumuladoDesde !== '' || summary.data.conciliacion !== null),
      backupOn: IS_WEB ? lastExport() !== null : !!settings?.data && (settings.data.driveConnected || settings.data.backupOnClose),
    }
  })
  // A failed read just hides the guide: it is a helper, never an error screen.
  return query.status === 'success' ? query.data : null
}

function readDismissed(userId: number): boolean {
  try {
    return localStorage.getItem(dismissKey(userId)) === '1'
  } catch {
    return false
  }
}

// OnboardingChecklist is the Guía de inicio at the top of the Resumen: the
// first steps of a new profile, each with the way to do it. It leaves on its
// own once the required steps are done, or when hidden (per profile).
// onOpeningBalance opens the Resumen's «Saldo inicial» dialog.
export function OnboardingChecklist({ onOpeningBalance }: { onOpeningBalance: () => void }) {
  const facts = useOnboardingFacts()
  const { active } = useProfiles()
  const setQuickAdd = useSetAtom(quickAddAtom)
  const [hiddenFor, setHiddenFor] = useState<number | null>(null)
  if (!facts || !active) return null
  if (hiddenFor === active.id || readDismissed(active.id)) return null
  const steps = onboardingSteps(facts, IS_WEB)
  if (onboardingDone(steps)) return null
  const required = steps.filter((s) => !s.optional)
  const doneCount = required.filter((s) => s.done).length

  function hide(userId: number) {
    try {
      localStorage.setItem(dismissKey(userId), '1')
    } catch {
      // Storage blocked: hidden for this session only.
    }
    setHiddenFor(userId)
  }

  return (
    <section aria-labelledby="onboarding-title" className="rounded-xl bg-panel p-5 shadow-xs ring-1 ring-line">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-fg">
            <Rocket className="size-5" />
          </span>
          <div>
            <h2 id="onboarding-title" className="font-semibold text-fg">
              Guía de inicio
            </h2>
            <p className="text-sm text-fg-muted">
              {doneCount} de {required.length} pasos listos
            </p>
          </div>
        </div>
        <IconButton label="Ocultar la guía de inicio" icon={X} onClick={() => hide(active.id)} />
      </div>
      <div className="mt-3">
        <Bar fill={doneCount / required.length} tone="success" />
      </div>
      <ol className="mt-4 divide-y divide-line">
        {steps.map((s) => (
          <li key={s.id} className="flex flex-wrap items-start gap-3 py-3 first:pt-0 last:pb-0">
            {s.done ? (
              <CircleCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-positive-fg" />
            ) : (
              <Circle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-fg-subtle" />
            )}
            <div className="min-w-0 flex-1">
              <p className={`text-sm font-medium ${s.done ? 'text-fg-muted line-through' : 'text-fg'}`}>
                {s.title}
                {s.optional && <span className="ml-1 font-normal text-fg-subtle">(opcional)</span>}
                <span className="sr-only">{s.done ? ' — listo' : ' — pendiente'}</span>
              </p>
              {!s.done && <p className="text-xs text-fg-muted">{s.description}</p>}
            </div>
            {!s.done && s.actions.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                {s.actions.map((a) =>
                  a.kind === 'quick-add' ? (
                    <Button key="quick-add" size="sm" onClick={() => setQuickAdd(true)}>
                      {a.label}
                    </Button>
                  ) : a.kind === 'opening-balance' ? (
                    <Button key="opening-balance" size="sm" variant="secondary" onClick={onOpeningBalance}>
                      {a.label}
                    </Button>
                  ) : (
                    <Link key={a.label} to={a.route} className="text-sm font-medium text-accent-fg underline-offset-2 hover:underline">
                      {a.label}
                    </Link>
                  ),
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}
