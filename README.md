# pendientes

Muestra en el pie del cuadro de escribir de Claude Code cuántos chats te esperan, por ejemplo `🔔 2`. Pensado para trabajar con la barra lateral cerrada y enterarte de cuándo termina otro chat.

- Cuenta un chat cuando termina un turno mientras estás en otro, hasta que lo abres.
- También cuenta los que esperan tu permiso o una pregunta tuya, aunque no hayan terminado.
- Incluye los chats laterales.
- A 0 no se muestra.
- Al pulsarlo, un aviso con los chats: `🔵` ha terminado, `🟡` te pide una decisión, `💬` chat lateral.

Lee archivos internos de la app de escritorio de Claude para macOS, sin documentar: una actualización de la app podría cambiarlos, y entonces verías `🔔 –`. Guarda lo que ve en `~/.claude/pendientes-estado-2.json` y las esperas de cada chat en `~/.claude/pendientes`. Las esperas solo funcionan en chats que tengan el mod cargado.

Combina bien con [working](https://github.com/manuelfp88/working) y [compactor](https://github.com/manuelfp88/compactor).

## Instalación

En una sesión de Claude Code en la terminal:

```
/plugin install pendientes --marketplace manuelfp88/pendientes
```

Responde `y` para añadir el catálogo y elige dónde instalarlo.

## Licencia

MIT
