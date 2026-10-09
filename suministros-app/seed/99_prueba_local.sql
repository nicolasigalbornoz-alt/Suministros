-- Usuarios de PRUEBA, solo para la base local de `wrangler dev`. Nunca aplicar en --remote.
INSERT OR REPLACE INTO usuarios (legajo, area, rol, clave_hash, activo) VALUES ('900001', 'Subsecretaría de Planificación Presupuestaria y Estadística', 'admin', 'pbkdf2$20000$RCUjT6qi+05PRyhIy9ew8g==$LUE7awT3TFNsE9njJzWYIGM4y9ErVHYoFFGWNQTQjFU=', 1);
INSERT OR REPLACE INTO usuarios (legajo, area, rol, clave_hash, activo) VALUES ('900003', 'Salud', 'area', 'pbkdf2$20000$KcwfrLL/UxgtVl9gGqO/ow==$JRWsW6jIO2ipI0ueEzFcECcIyXT7ibyIigNcZ4OkST4=', 1);
INSERT OR REPLACE INTO usuarios (legajo, area, rol, clave_hash, activo) VALUES ('900005', 'Educación y Des. De la Com.', 'area', 'pbkdf2$20000$dI1GL4dX6Xr3N2t3EYAyIA==$HEolwzvqE4Wm2ANY5jEQvjwsIUTlP374yh84tNCTwi0=', 1);
INSERT OR REPLACE INTO usuarios (legajo, area, rol, clave_hash, activo) VALUES ('900008', 'Dirección de Compras', 'compras', 'pbkdf2$20000$Qzha3KKaMLF3m+/yT0ol1w==$DDH+5rywa1o5BIiA7vp9DVaWP4C6SuqqlvhMs0Ikb6g=', 1);
