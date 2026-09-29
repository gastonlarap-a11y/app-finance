# App Finance

Un **gestor de finanzas personales** (UI en español) construido con [Wails v3](https://v3.wails.io) —
Go backend enlazado a un frontend React, empaquetado como app nativa para **macOS y Windows**.
Además se distribuye como **PWA instalable para iPad/web**: el mismo frontend con un motor
TypeScript local sobre SQLite-wasm (datos 100 % en el dispositivo, sin servidor); ver
`ARCHITECTURE.md` §17. Para instalarla en un iPad: abrir la URL publicada (GitHub Pages) en Safari
→ Compartir → **Añadir a pantalla de inicio**, y usar «Exportar datos» (barra lateral o
Configuración › Respaldo) como respaldo.

## Funcionalidades

La navegación es una **barra lateral agrupada** (Resumen, Importar, Buscar · Análisis · Planificar) con
**Configuración** al pie: lo que cambia mes a mes vive en las vistas del mes; lo que se ajusta una vez
(tarjetas, cuentas, categorías, comercios, reglas, respaldo, perfiles, papelera…) vive en Configuración.
Cada pantalla tiene su URL (`#/resumen`, `#/config/tarjetas`…) y la app reabre la última visitada.

- **Resumen del mes**: sueldo del mes (el sueldo base se repite solo como «esperado» hasta que lo confirmas),
  ingresos extra y tabla de movimientos que combina cuotas de tarjeta
  de crédito y gastos fijos recurrentes; totales en vivo (disponible, gastos, balance, ¿alcanza?), cupo de
  tarjetas y saldo de cuentas.
- **Importar**: estados de cuenta de tarjeta en PDF (Itaú, Banco de Chile, Cencosud Scotiabank y CMR
  Falabella), la cartola de Itaú en PDF y cartolas de cualquier banco en CSV. Todo llega a una bandeja
  donde confirmas cada movimiento antes de que cuente.
- **Gastos fijos**: suscripciones/servicios que se trasladan automáticamente cada mes. Editar el monto de
  un mes aplica **desde ese mes en adelante** — los meses anteriores conservan su valor. Cada cargo puede
  marcarse pagado/pendiente por mes.
- **Año**: resumen anual con balance acumulado, desglose por mes y un mapa de calor de **gasto por
  categoría × mes** (clic en un mes para abrirlo).
- **Presupuestos por categoría**: tope mensual por categoría que rige **desde un mes en adelante**
  (igual que los montos de gastos fijos). El mes muestra lo gastado vs. el tope y avisa al excederlo.
- **Proyección**: próximos 6/12/24 meses con lo ya comprometido (cuotas pendientes + gastos fijos)
  contra el sueldo (el base; sin sueldo base, el último conocido) → cuánto queda libre y el saldo
  proyectado.
- **Buscar**: busca gastos en todo el historial por texto (descripción/comercio), categoría, tarjeta
  y rango de meses.
- **Ahorro**: metas con monto y fecha objetivo; cada aporte sale del disponible del mes (se muestra
  aparte de los gastos) y la app calcula cuánto ahorrar al mes para llegar a tiempo.
- **Tendencia**: en el mes, comparación con el mes anterior y el promedio de 6 meses (total y por
  categoría) con un gráfico de línea.
- **Recurrentes**: en «Fijos», detecta gastos únicos que se repiten con monto parecido y los convierte
  en gasto fijo con un clic.
- **Exportar**: mes, año y resultados de búsqueda a Excel (.xlsx con diálogo nativo) en desktop, o CSV
  (Compartir/Archivos) en el iPad.
- **Configuración › Tarjetas / Cuentas / Categorías y presupuestos / Etiquetas / Comercios / Reglas de
  importación**: todo lo que se configura una vez.
- **Cuentas y transferencias**: cuentas corrientes, vista, digitales/prepago (Mercado Pago), efectivo y
  ahorro, cada una con su saldo. Una tarjeta y un gasto fijo (el dividendo por PAC) indican de qué cuenta
  se pagan; las transferencias entre tus cuentas (el sueldo que pasas a otro banco, la carga de Mercado
  Pago), únicas o mensuales, mueven el saldo de cada cuenta sin contar como gasto ni ingreso. Una
  transferencia puede pasar «el resto del sueldo» (el sueldo de cada mes menos lo que se queda, como el
  dividendo), y cada cuenta se concilia con el saldo real del banco desde el panel Cuentas del Resumen.
- **Catálogo sugerido**: con un botón en Categorías o Comercios agrega las categorías habituales en
  Chile (con su ícono y color) y ~200 comercios conocidos con su categoría y las reglas que los reconocen
  al importar. Un comercio con categoría habitual la propone al elegirlo en un gasto (Apple →
  Tecnología). No duplica ni cambia lo que ya tienes.
- **Paleta de comandos** (`⌘K` / Ctrl+K, o «Ir a…» en la barra lateral): ir a cualquier pantalla o
  sección de Configuración, agregar un gasto, cambiar de mes, de tema o de perfil, respaldar, o buscar
  gastos por texto. Recuerda lo último que usaste.
- **Guía de inicio**: en el Resumen de un perfil nuevo, los primeros pasos (tarjeta o cuenta,
  categorías, sueldo, primer gasto y respaldo) con el botón para hacer cada uno; desaparece sola al
  completarlos o con «Ocultar».
- **Atajos**: `⌘K` abre la paleta; `N` abre «Agregar gasto» desde cualquier pantalla; `←`/`→` cambian
  de mes (o de año en «Año»); `⌘1`…`⌘7` (Ctrl en Windows) saltan a cada sección de la barra lateral y
  `⌘,` abre Configuración. Ninguno actúa con un diálogo abierto. En el iPad, deslizar el dedo hacia
  los lados cambia de mes (o de año) en Resumen, Gastos fijos, Proyección y Año.
- **Perfiles (multi-usuario, sin login)**: varios perfiles sobre una sola base de datos; cada uno ve
  únicamente sus datos y el cambio de perfil es instantáneo (pie de la barra lateral; crear y eliminar en
  Configuración › Perfiles).
- **Papelera** (Configuración): eliminar tarjetas, categorías, ingresos, gastos, gastos fijos o perfiles
  los manda a la papelera (soft delete) con opción de restaurar; no se borran de inmediato.
- **Configuración › Respaldo y Google Drive**: elegir la carpeta de la base de datos, conectar Google
  Drive y hacer backup de la BD (bajo demanda —también desde la barra lateral— o al cerrar).

## Stack

| Capa | Tecnología |
|---|---|
| Runtime | Go 1.27 · [Wails v3](https://v3.wails.io) (Service pattern) |
| Datos | [bun](https://bun.uptrace.dev) ORM + bun/migrate · SQLite (`modernc.org/sqlite`, pure Go, sin CGO) |
| Frontend | React 19 (+ React Compiler) · [Jotai](https://jotai.org) · Tailwind CSS v4 · Vite 8 · TypeScript 5.9 |
| Calidad | golangci-lint v2 · govulncheck · ESLint 9 (typescript-eslint type-aware, react-hooks, jsx-a11y) · Vitest |
| Logging | `log/slog` (consola via [tint](https://github.com/lmittmann/tint), archivos rotativos via lumberjack) |
| Dinero | `shopspring/decimal` (serializado como strings en el bridge) |
| Reportes | Exportación Excel via [excelize](https://github.com/xuri/excelize) |
| Backup | Google Drive via `golang.org/x/oauth2` + `google.golang.org/api` |

> **Wails v3 está en beta** (API estable, aún pre-release). Este proyecto fija
> `github.com/wailsapp/wails/v3 v3.0.0-beta.25` y `@wailsio/runtime 3.0.0-beta.25`.
> Mantener el CLI `wails3` en la **misma** versión que la librería Go. Ver `ARCHITECTURE.md` §2.

---

## 1. Instalación

### Herramientas necesarias

| Herramienta | Versión | Cómo instalar |
|---|---|---|
| [Go](https://go.dev/dl/) | 1.27+ | Descargar del sitio oficial |
| [Node.js](https://nodejs.org/) | 24 LTS (`frontend/.nvmrc`) | Descargar del sitio oficial |
| Wails v3 CLI | v3.0.0-beta.25 | Ver abajo |
| [Task](https://taskfile.dev) | 3.x | `go install github.com/go-task/task/v3/cmd/task@latest` (opcional: sin Task, `wails3 task <nombre>` corre el mismo Taskfile) |
| [golangci-lint](https://golangci-lint.run) | v2.13+ | `brew install golangci-lint` (sólo para `task lint`/`task check`) |

### Pasos

**1. Instalar el CLI de Wails v3:**
```bash
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.25
```

**2. Asegurarse de que el bin de Go esté en PATH** (agregar a `.zshrc` / `.bashrc` si no está):
```bash
export PATH="$PATH:$(go env GOPATH)/bin"
```

**3. Verificar que todo el toolchain esté instalado correctamente:**
```bash
wails3 doctor
```

**4. Copiar y ajustar la configuración:**
```bash
cp config.example.toml config.toml
# Editar config.toml si se quiere cambiar log_level, db_filename, etc.
```

**5. Instalar dependencias del frontend:**
```bash
cd frontend && npm install && cd ..
```

**6. Instalar Chromium headless para los tests de UI** (una vez por máquina; lo usa el proyecto
`browser` de vitest en `npm test` / `task test`):
```bash
cd frontend && npx playwright install chromium && cd ..
```

Ya está listo para desarrollar.

---

## 2. Desarrollo

```bash
wails3 dev
# o equivalente:
task dev
```

Esto compila el backend Go, inicia el servidor Vite en `http://localhost:9245`, abre la ventana de
la app y activa el hot-reload para cambios en Go y en el frontend.

> ⚠️ **No ejecutar `wails dev`** — ese es el CLI de Wails **v2** y falla con *"Unable to find Wails
> in go.mod"*. Este es un proyecto v3; usar siempre `wails3` o `task`.

**Compilación rápida del backend** (sin levantar la ventana):
```bash
go build . && go vet ./...
```

**Calidad (lo mismo que corre CI):**
```bash
task check       # go vet + lint (Go + ESLint) + typecheck (desktop + web) + tests + build web
task test        # go test -race ./... + vitest
task lint        # golangci-lint run ./... + npm run lint
task vuln        # govulncheck + npm audit (dependencias de producción)
```
El typecheck desktop necesita los bindings generados (`wails3 generate bindings -ts`): el wrapper
`frontend/src/services/finance.ts` asigna los bindings al contrato escrito a mano
(`services/contract.ts`), así que un cambio de firma en Go no reflejado en el contrato falla aquí.

**Un solo test mientras se itera:**
```bash
go test -run TestName ./backend/finance                             # un test de Go
cd frontend && npx vitest run --project unit|browser [archivo]      # un proyecto / un archivo de vitest
```

**Target web/PWA (iPad)** — el mismo frontend sobre el motor TS local, sin backend Go:
```bash
cd frontend && npm run dev:web     # servidor de desarrollo (abrir /app-finance/ en el navegador)
cd frontend && npm run build:web   # typecheck (tsconfig.web.json) + bundle PWA → dist/
```

---

## 3. Build y distribución — macOS

### Compilar el binario
```bash
task build
# o equivalente:
wails3 build
# → bin/app-finance
```
Genera el binario de producción (stripped, sin símbolos de debug).

### Crear el bundle .app
```bash
task package
# → bin/app-finance.app
```
Empaqueta el binario en un `.app` bundle firmado ad-hoc. Se puede arrastrar a `/Applications`.

### Crear el .dmg para distribución
```bash
task package:dmg
# → bin/app-finance.dmg
```
Crea un disco de imagen comprimido a partir del `.app`. Este es el archivo ideal para compartir —
el usuario lo abre, arrastra la app a su carpeta de Aplicaciones y listo.

> El `.app` **no está notarizado** (notarización requiere cuenta de Apple Developer ~$99/año). Lo que
> compilas en tu Mac abre directo; lo **descargado** (Release) trae la marca de cuarentena y Gatekeeper
> lo bloquea la primera vez («Apple no pudo verificar…»). **No elijas «Trasladar a la Papelera»**:
> pulsa OK → **Ajustes del Sistema → Privacidad y seguridad → Abrir igualmente** (desde macOS 15 el
> clic derecho → Abrir ya no lo permite), o en Terminal:
> `xattr -dr com.apple.quarantine /Applications/app-finance.app`.

---

## 4. Build y distribución — Windows

> Se cross-compila desde macOS sin Docker (se usa `modernc.org/sqlite`, pure Go, sin CGO).

### Prerrequisito único (una sola vez)
```bash
brew install makensis
```
`makensis` es el compilador de instaladores NSIS (necesario solo para el paso de packaging).

### Compilar el .exe
```bash
task build:windows
# → bin/app-finance.exe  (amd64, para Windows x86_64 estándar)
```

### Crear el instalador NSIS
```bash
task package:windows
# → bin/app-finance-amd64-installer.exe
```
El instalador:
- Instala la app en `C:\Program Files\app-finance`
- Crea una entrada en el **Menú Inicio**
- Aparece en **"Agregar o quitar programas"** con desinstalador incluido

> **SmartScreen:** Al ejecutar el instalador por primera vez, Windows muestra la advertencia de
> SmartScreen porque el archivo no tiene firma de código comercial. Hacer clic en
> **"Más información" → "Ejecutar de todos modos"** (solo una vez al instalar). Luego la app abre
> normalmente sin advertencias. La firma de código requiere un certificado pago (~$400 USD/año);
> para uso familiar no es necesario.

---

## 5. Bindings TypeScript

Cuando se modifica o agrega un método exportado en el backend Go, hay que regenerar los bindings:

```bash
wails3 generate bindings -ts
# → frontend/bindings/  (gitignoreado, se auto-regenera en `wails3 dev`)
```

Los bindings se gitignoran y se regeneran automáticamente. Nunca importar de `frontend/bindings/`
directamente — usar los wrappers en `frontend/src/services/`.

---

## 6. Configuración

`config.toml` es la fuente de verdad (gitignoreado — copiar de `config.example.toml`):

```toml
display_name  = "App Finance"
log_level     = "info"         # debug | info | warn | error
db_filename   = "app-finance.db"
data_strategy = "osstandard"   # osstandard | besideexe
# data_dir    = "/ruta/a/sqlite"  # opcional; Configuración › Respaldo tiene prioridad
```

Variables de entorno del proceso (no se lee ningún archivo `.env`) que sobreescriben claves
individuales:

| Variable | Sobreescribe |
|---|---|
| `DISPLAY_NAME` | `display_name` |
| `LOG_LEVEL` | `log_level` |
| `DB_FILENAME` | `db_filename` |
| `DATA_STRATEGY` | `data_strategy` |
| `DB_DATA_DIR` | `data_dir` |
| `BACKUP_LOCAL_DIR` | carpeta de copias locales del backup |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | cliente OAuth de Drive (si no se pega en Configuración › Respaldo) |

Las preferencias configuradas desde **Configuración › Respaldo y Google Drive** (carpeta de BD,
Drive/OAuth, backup al cerrar) tienen prioridad en runtime via `backend/shared/prefs`.

El backup de Google Drive (cliente OAuth, carpeta, backup al cerrar) se configura enteramente desde
**Configuración › Respaldo y Google Drive** — no requiere claves en config.toml.

---

## 7. Estructura del proyecto

```
app-finance/
├── main.go                 # punto de entrada — único lugar de orquestación
├── Taskfile.yml            # atajos de tasks (dev/build/run/package); incluye build/**
├── build/                  # assets de build de Wails: config.yml + Taskfiles por OS, Info.plist, íconos
│   ├── darwin/             # macOS: Info.plist, icons.icns
│   ├── windows/            # Windows: icon.ico, info.json, nsis/project.nsi
│   └── linux/              # Linux: Taskfile, .desktop, nfpm
├── wails.json              # config vestigial de v3 (el build usa build/config.yml)
├── config.toml             # config de la app (gitignoreado)
│
├── backend/
│   ├── finance/            # dominio core: card/category/expense/income/installment/merchant/salary/
│   │                       #   settings/fixedexpense.go, period.go, result.go, service.go, migrations/
│   │                       #   + budget.go (presupuestos), forecast.go (proyección), search.go (búsqueda),
│   │                       #   savings.go (metas de ahorro), trend.go (tendencia), recurring.go
│   ├── users/              # perfiles multi-usuario (sin login): user/session/service.go, migrations/
│   ├── settings/           # carpeta BD, Google Drive, backup al cerrar
│   ├── diagnostics/        # servicio de diagnóstico (error reporting)
│   ├── reports/            # excel.go — SaveTable: .xlsx + diálogo nativo «Guardar como»
│   ├── updates/            # actualizaciones in-app (Wails pkg/updater, firma Ed25519, solo escritorio)
│   ├── reminders/          # notificaciones nativas de vencimientos (solo escritorio)
│   ├── mailsync/           # solo migraciones retiradas del antiguo sync de correo
│   └── shared/
│       ├── config/         # cargador de config
│       ├── prefs/          # prefs de usuario que sobreescriben config
│       ├── db/             # conexión + migrador
│       ├── logger/         # setup de slog
│       ├── errors.go       # tipo AppError para errores de negocio
│       ├── windowstate/    # persistir geometría de ventana en app_settings
│       ├── background/     # pool genérico de goroutines
│       ├── backup/         # snapshot SQLite + upload a Drive
│       ├── drive/          # manager OAuth de Google Drive
│       └── types/          # Decimal (dinero)
│
├── tools/updatesign/       # firma/verificación Ed25519 de los artefactos de actualización
│
└── frontend/
    ├── index.html · vite.config.ts · package.json · tsconfig.json
    └── src/
        ├── main.tsx · App.tsx · index.css
        ├── atoms/                        # estado Jotai de UI (period, quick-add, refresh)
        ├── services/{finance,users,settings,diagnostics,reports,updates}.ts  # wrappers tipados por contract.ts
        ├── services/web/*                # adaptadores del target web (motor TS local)
        ├── engine/                       # port TS del dominio sobre sqlite-wasm (target web)
        ├── lib/{route,useRoute,shortcuts,theme,format,money,result,notify,useQuery}.ts
        ├── lib/statements/               # parsers de cartolas y estados de cuenta (PDF/CSV, compartidos)
        └── components/
            ├── shell/                    # AppShell, Sidebar, PeriodNav, QuickAddHost, MobileTopBar
            ├── config/                   # hub de Configuración (sections.tsx) y sus secciones nuevas
            ├── ui/                       # primitivas (Button, Menu, Tabs, Callout, ConfirmAction…)
            └── MonthView, YearView, ForecastView, SearchView, FixedExpensesView, CardsView, …
```

---

## Integración continua

`.github/workflows/ci.yml` corre en cada `pull_request` y en `push` a `main`:

- **desktop** (macOS): `go vet`, golangci-lint, `go test -race`, govulncheck, compilación; luego
  instala el `wails3` de la versión fijada en `go.mod`, genera los bindings y corre ESLint + typecheck
  desktop/web del frontend.
- **web** (ubuntu): vitest (paridad del motor TS + tests de UI en Chromium headless), typecheck +
  bundle PWA y `npm audit` de producción.
- **gitleaks**: escaneo de secretos.

`.github/workflows/deploy-web.yml` publica la PWA en GitHub Pages cada vez que CI termina en verde
sobre un push a `main` (compila ese mismo commit: tests del motor + `build:web`). Dependabot (`.github/dependabot.yml`) propone actualizaciones semanales
agrupadas de Go, npm y GitHub Actions (Wails y `@wailsio/runtime` quedan fuera: se suben juntos a mano).
`.github/workflows/release.yml` publica los instaladores: al subir un tag `vX.Y.Z` compila en macOS el
`.dmg` universal (Apple Silicon + Intel) y el instalador NSIS de Windows, y los sube como **GitHub
Release** con `SHA256SUMS.txt`. Los artefactos del actualizador integrado se firman con Ed25519 en un
job aparte (`sign`): la clave privada es el secreto `UPDATE_SIGNING_KEY` del environment `release`, y
la pública está en `backend/updates/update_signing.pub`. La app rechaza toda actualización que no esté
firmada con esa clave. El tag debe coincidir con `info.version` de `build/config.yml` (el job falla si
no). Para publicar una versión:

```bash
# 1. subir la versión en build/config.yml (info.version) y regenerar los assets
wails3 task common:update:build-assets
# 2. mergear a main (PR) y luego, desde main actualizado:
git tag v0.3.0 && git push origin v0.3.0
```

Ejecutarlo manualmente (*Run workflow*) genera los mismos instaladores como artifacts sin publicar
(prueba en seco). Las secciones 3 y 4 describen el empaquetado local equivalente.

**Actualizar la app instalada**: descarga el último Release; en macOS arrastra `app-finance` a
Aplicaciones (reemplaza la anterior) y la primera vez autorízala en **Privacidad y seguridad →
Abrir igualmente** (ver la nota de la sección 3); en Windows ejecuta el instalador (se instala
encima). Los datos no se tocan y las migraciones se aplican solas al abrir; conviene «☁ Respaldar»
antes.

## Más

La arquitectura, el Service pattern de Wails, las migraciones, el manejo de errores y cómo agregar
un nuevo dominio están documentados en **[ARCHITECTURE.md](./ARCHITECTURE.md)**.
