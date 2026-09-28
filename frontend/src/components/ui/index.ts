// Shared UI primitives. Views import from '@/components/ui' (or './ui'); build
// screens from these and the semantic color tokens in index.css, never from raw
// palette colors (src/styles/rawclasses.test.ts).
export { Button, IconButton } from './Button'
export { Badge, Callout, Empty, EmptyState, QueryError, Skeleton, SkeletonRows, Spinner, type Tone } from './feedback'
export { SegmentedControl, TabPanel, Tabs, type ChoiceOption } from './Tabs'
export { Menu, Toggletip, type MenuAction } from './Menu'
export { ConfirmAction } from './ConfirmAction'
export { ConfirmDialog } from './ConfirmDialog'
export { tbl } from './table'
export { Banner, PageHeader, Section, StatCard } from './layout'
export { Field, Input, MoneyInput, Select, Switch, inputCls } from './form'
export { Modal } from './Modal'
export { Toaster } from './Toaster'
export { Bar, BankCodes, BankDescription, TagChips } from './data'
