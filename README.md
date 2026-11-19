# ULTRON // Local AI Workstation

A private, in-browser AI workstation running **Gemma3-1B-IT** (LiteRT INT4) locally via **WebGPU**, featuring:
- **3D Three.js Neumorphic Audio-Reactive Orb**
- **Offline Voice Input (Speech Recognition) & Output (TTS Synthesis)**
- **Document Export**: PDF, DOCX, and Markdown
- **Installable PWA**: Run as a standalone Chrome desktop application

---

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Run Development Server
```bash
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) in Google Chrome or Microsoft Edge (WebGPU supported).

### 3. Production Build
```bash
npm run build
```
Creates an optimized, single-file bundle ready for offline deployment.

---

## Git & GitHub Setup

To push this repository to GitHub:

```bash
git init
git add .
git commit -m "Initial commit - ULTRON Local AI Workstation"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
git push -u origin main
```
> **Note**: `node_modules` is automatically ignored by `.gitignore`. Anyone cloning this repository simply runs `npm install`.
