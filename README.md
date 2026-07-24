# App Finance

Un **gestor de finanzas personales** (UI en español) construido con [Wails v3](https://v3.wails.io) —
Go backend enlazado a un frontend React, empaquetado como app nativa para **macOS y Windows**.
Además se distribuye como **PWA instalable para iPad/web**: el mismo frontend con un motor
TypeScript local sobre SQLite-wasm (datos 100 % en el dispositivo, sin servidor); ver
`ARCHITECTURE.md` §17. Para instalarla en un iPad: abrir la URL publicada (GitHub Pages) en Safari
→ Compartir → **Añadir a pantalla de inicio**, y usar «Exportar datos» en Ajustes como respaldo.

## Funcionalidades

- **Mes**: sueldo mensual, ingresos extra y tabla de movimientos que combina cuotas de tarjeta de crédito
  y gastos fijos recurrentes; totales en vivo (disponible, gastos, balance, ¿alcanza?).
- **Gastos fijos**: suscripciones/servicios que se trasladan automáticamente cada mes. Editar el monto de
  un mes aplica **desde ese mes en adelante** — los meses anteriores conservan su valor. Cada cargo puede
  marcarse pagado/pendiente por mes.
- **Año**: resumen anual con balance acumulado, desglose por mes y por categoría.
- **Tarjetas / Categorías / Comercios**: administrar tarjetas de crédito (cupo, día de cierre),
  categorías y comercios.
- **Perfiles (multi-usuario, sin login)**: varios perfiles sobre una sola base de datos; cada uno ve
  únicamente sus datos y el cambio de perfil es instantáneo.
- **Papelera**: eliminar tarjetas, categorías, ingresos, gastos, gastos fijos o perfiles los manda a
  la papelera (soft delete) con opción de restaurar; no se borran de inmediato.
- **Ajustes**: elegir la carpeta de la base de datos, conectar Google Drive y hacer backup de la BD
  (bajo demanda o al cerrar).

## Stack

| Capa | Tecnología |
|---|---|
| Runtime | Go 1.25+ · [Wails v3](https://v3.wails.io) (Service pattern) |
| Datos | [bun](https://bun.uptrace.dev) ORM + bun/migrate · SQLite (`modernc.org/sqlite`, pure Go, sin CGO) |
| Frontend | React 19 · [Jotai](https://jotai.org) · Tailwind CSS v4 · Vite |
| Logging | `log/slog` (consola via [tint](https://github.com/lmittmann/tint), archivos rotativos via lumberjack) |
| Dinero | `shopspring/decimal` (serializado como strings en el bridge) |
| Reportes | Exportación Excel via [excelize](https://github.com/xuri/excelize) |
| Backup | Google Drive via `golang.org/x/oauth2` + `google.golang.org/api` |

> **Wails v3 está en alpha.** Este proyecto fija `github.com/wailsapp/wails/v3 v3.0.0-alpha2.108`.
> Mantener el CLI `wails3` en la **misma** versión que la librería Go. Ver `ARCHITECTURE.md` §2.

---

## 1. Instalación

### Herramientas necesarias

| Herramienta | Versión | Cómo instalar |
|---|---|---|
| [Go](https://go.dev/dl/) | 1.25+ | Descargar del sitio oficial |
| [Node.js](https://nodejs.org/) | 20+ | Descargar del sitio oficial |
| Wails v3 CLI | v3.0.0-alpha2.108 | Ver abajo |
| [Task](https://taskfile.dev) | 3.x | `go install github.com/go-task/task/v3/cmd/task@latest` |

### Pasos

**1. Instalar el CLI de Wails v3:**
```bash
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-alpha2.108
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

**Tests:**
```bash
go test ./...                  # tests del backend (dominios finance + users)
cd frontend && npm run build   # typecheck del frontend (tsc --noEmit) + bundle
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

> El `.app` **no está notarizado** (notarización requiere cuenta de Apple Developer ~$99/año). Para
> uso personal/familiar en tu mismo Mac funciona perfectamente. En un Mac ajeno, Gatekeeper puede
> bloquear el primer arranque: clic derecho → Abrir → Abrir igualmente.

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
# → build/windows/nsis/app-finance-installer.exe
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
# data_dir    = "/ruta/a/sqlite"  # opcional; la pestaña Ajustes tiene prioridad
```

Las variables de entorno (`.env`) sobreescriben claves individuales. Las preferencias configuradas
desde la pestaña **Ajustes** de la app (carpeta de BD, Drive/OAuth, backup al cerrar) sobreescriben
el config en runtime via `backend/shared/prefs`.

El backup de Google Drive (cliente OAuth, carpeta, backup al cerrar) se configura enteramente desde
la pestaña **Ajustes** — no requiere claves en config.toml.

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
│   ├── users/              # perfiles multi-usuario (sin login): user/session/service.go, migrations/
│   ├── settings/           # carpeta BD, Google Drive, backup al cerrar
│   ├── diagnostics/        # servicio de diagnóstico (error reporting)
│   ├── reports/            # excel.go — exportación Excel
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
└── frontend/
    ├── index.html · vite.config.ts · package.json · tsconfig.json
    └── src/
        ├── main.tsx · App.tsx · index.css
        ├── atoms/finance.ts              # estado Jotai (tab, period, refresh)
        ├── services/{finance,users,settings}.ts   # wrappers sobre los bindings generados
        ├── lib/{format,result}.ts
        └── components/                   # MonthView, YearView, FixedExpensesView, CardsView,
                                          #   CategoriesView, MerchantsView, TrashView, UserSwitcher,
                                          #   SettingsView, IncomePanel, ExpenseForm, …
```

---

## Integración continua

`.github/workflows/ci.yml` corre en cada `pull_request` y en `push` a `main`: `go vet` + `go test` +
compilación del backend, typecheck y bundle del frontend (`npm run build`), y escaneo de secretos con
gitleaks. No hay job de deploy — la distribución es manual (secciones 3 y 4).

## Más

La arquitectura, el Service pattern de Wails, las migraciones, el manejo de errores y cómo agregar
un nuevo dominio están documentados en **[ARCHITECTURE.md](./ARCHITECTURE.md)**.
