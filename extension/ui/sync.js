// syncClient.js ya deduplica delegando al service worker (ver su propio comentario);
// este módulo solo existe para que el resto de ui/ importe "./sync.js" con el mismo
// nombre que su equivalente en web/ui/, sin acoplarse a la ruta real del cliente.
export { requestSync } from "../syncClient.js";
