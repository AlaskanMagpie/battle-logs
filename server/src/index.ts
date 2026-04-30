import http from "node:http";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { BattleRoom } from "./BattleRoom.js";

const port = Number(process.env.COLYSEUS_PORT ?? 2567);
const server = http.createServer();

const gameServer = new Server({
  transport: new WebSocketTransport({ server }),
});

gameServer.define("battle_room", BattleRoom);

gameServer.listen(port).then(() => {
  console.log(`[multiplayer] Colyseus listening on ${port}`);
});
