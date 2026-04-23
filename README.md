# RoutePilot Pro

RoutePilot Pro est une application web responsive en Bootstrap, orientee productivite terrain, avec mode PWA installable.

## Fonctionnalites

1. Creation et edition de tournees avec point de depart et etapes geolocalisees.
2. Optimisation automatique de l'ordre des etapes (nearest neighbor + 2-opt).
3. Visualisation sur carte Leaflet avec trace d'itineraire et mode ajout par clic.
4. Export JSON/CSV, import JSON, partage rapide et ouverture Google Maps.
5. Theme clair/sombre, support offline via service worker et installation PWA.

## Stack

1. Bootstrap 5.3
2. Leaflet
3. Nominatim (OpenStreetMap) pour la recherche d'adresses
4. OSRM public pour le trace routier

## Lancer localement

1. Ouvrir le dossier dans un serveur statique (ou VS Code Live Server).
2. Charger [index.html](index.html).
3. Installer la PWA depuis le bouton "Installer l'app" quand disponible.
