// Test-only builders for card-statement inputs: every field blank, so a test
// spells out only what its scenario is about.
import type { CardStatementInput, CardStatementLineInput } from '@/services/contract'

export const blankStatement: CardStatementInput = {
  issuer: '', kind: '', currency: '', cardLastDigits: '', statementDate: '', periodFrom: '', periodTo: '',
  dueDate: '', previousPeriodFrom: '', previousPeriodTo: '', nextPeriodFrom: '', nextPeriodTo: '',
  creditLimit: '', creditUsed: '', creditAvailable: '', cashLimit: '', cashUsed: '', cashAvailable: '',
  previousBalanceStart: '', previousBilled: '', previousPaid: '', previousBalanceEnd: '', transferFromNational: '',
  totalOperations: '', voluntaryProducts: '', chargesNet: '', totalBilled: '', minimumPayment: '',
  prepaymentCost: '', automaticCharge: '', unbilledBalance: '', rateRevolving: '', rateInstallments: '',
  rateCashAdvance: '', caeRevolving: '', caeInstallments: '', caeCashAdvance: '', caePrepayment: '',
  lateInterestRate: '', fileHash: '', lines: [], schedule: [],
}

export const statementLine = (l: Partial<CardStatementLineInput>): CardStatementLineInput => ({
  section: '',
  place: '',
  city: '',
  country: '',
  operationDate: '',
  reference: '',
  description: '',
  interestRate: '',
  operationAmount: '',
  totalAmount: '',
  installmentNumber: 0,
  installmentsTotal: 0,
  installmentAmount: '',
  originAmount: '',
  ...l,
})
