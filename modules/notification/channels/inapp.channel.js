'use strict';

/**
 * @file inapp.channel.js — canal de notification in-app.
 *
 * La « livraison » in-app, c'est la persistance : la ligne Notification EST le
 * message dans la boîte de réception. Il n'y a donc aucun appel externe — le
 * canal est toujours « configuré » et l'envoi réussit dès que la ligne existe.
 */

const isConfigured = () => true;

// Le document est déjà créé par le service ; rien à transmettre.
const send = async () => ({ ok: true });

module.exports = { name: 'inapp', isConfigured, send };
