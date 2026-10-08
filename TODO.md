# TODO

## Done

### Backend
- [x] Backend service (Fastify + TypeScript) in a pnpm monorepo
- [x] Config editor — YAML tab with schema validation, backups, hot reload
- [x] Métricas CPU/RAM — barras por máquina, vía agente SSH
- [x] Métricas disco — barras por partición
- [x] Métricas temperatura — barras por sensor
- [x] Métricas red — throughput por interfaz
- [x] Historial de métricas + sparklines
- [x] Health check HTTP/TCP — indicador verde/rojo con response time
- [x] Credenciales del router fuera de `localStorage` (ahora server-side)

### Frontend
- [x] Terminar sidebar sección de servicios → pestaña Servicios completa
- [x] Command palette (Ctrl+K) sobre dispositivos, servicios, puertos, contenedores
- [x] Filtros por tipo + búsqueda de texto en la grilla
- [x] Routing por hash — pestañas enlazables y persistentes al recargar
- [x] Navegación por teclado + atajos

### Topology
- [x] Topología de red — diagrama SVG integrando netmap
- [x] Descubrimiento de servicios automático (netmap sidecar)
- [x] Reconciliación de hosts descubiertos contra `config.yaml` por MAC/IP

## Pending

### Topology
- [ ] Mostrar puertos abiertos descubiertos por nmap en el nodo del mapa
      (el sidecar los recolecta; hoy sólo aparecen en el tooltip)
- [ ] Botón "agregar a config.yaml" en un host descubierto pero no configurado

### Metrics
- [ ] Alertas — avisar cuando un servicio cae o un disco pasa un umbral
- [ ] Persistir el historial de métricas entre reinicios (hoy vive en memoria)
- [ ] Estado real de contenedores Docker (hoy sale de `config.yaml`, no del daemon)

### Infra
- [ ] Autenticación delante del dashboard antes de exponerlo fuera de la LAN
- [ ] Wake-on-LAN desde la tarjeta del dispositivo
- [ ] CI que corra `make check` en cada push
