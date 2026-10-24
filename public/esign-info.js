// Copyright 2026 Limestone Labs LLC. SPDX-License-Identifier: Apache-2.0
'use strict';
// What e-signing here collects, does, shows, and doesn't show. One copy, used by the
// sender's panel, the signer's consent step, and /esign. Keep it plain and accurate.
const ESIGN_INFO = [
  {h: 'What we collect', items: [
    'The document, encrypted in the sender’s browser before it is uploaded. Our server cannot read it.',
    'Signer names, field positions and what each signer fills in, encrypted the same way.',
    'For every step (request created, sent, opened, wrong access code, agreed to sign electronically, signed, finished): the time from our server’s clock, the IP address, an approximate location looked up from that IP address (city, region, country), and the browser and device type.',
    'A fingerprint (SHA-256 hash) of the document as sent, and of the finished signed file.',
    'If the sender requires access codes, only salted hashes of them. We never store the codes themselves.',
    'We do not collect email addresses or phone numbers (the sender delivers links), GPS location, photos or ID documents, or payment details, and there are no ad or tracking cookies.',
  ]},
  {h: 'What we do with it', items: [
    'Show the sender who has opened and signed.',
    'Add a Signature Certificate page to the end of the finished PDF listing the details above for each signer.',
    'Keep a tamper-evident audit log: each event’s fingerprint includes the previous one, and our server signs each one, so changing or deleting an event is detectable.',
    `Let anyone check a finished PDF at ${APP.domain}/verify. Only the file’s fingerprint is sent, not the file.`,
    `Delete the encrypted document files ${APP.docSpan} after sending (or right away if the sender cancels). The audit record is deleted after ${APP.auditSpan}.`,
    'We do not sell, share or analyze any of it. Our host, Cloudflare, processes requests to run the site and may log them briefly for security.',
  ]},
  {h: 'What the record shows', items: [
    'That someone holding a signer’s link (and access code, if the sender required one) opened the document, agreed to sign electronically, and adopted the signature at the recorded time. The certificate says which way each signer got in.',
    'That the document each signer saw matched the one that was sent, and, if Verify passes, that the finished file has not changed since signing.',
    'The network and kind of device each step came from.',
  ]},
  {h: 'What it does not prove', items: [
    'Who the person really is. Without an access code, anyone who has the link can sign. With one, they also need the code, which helps only if it was sent a different way than the link (for example, link by email and code by text). Neither proves identity, and we do not check ID.',
    'That the link reached the right person. Big e-signature services email links themselves and record that; here the sender delivers links, so delivery is not part of the record.',
    'Where they were. Location from an IP address is approximate and often wrong with VPNs, mobile networks and company networks.',
    'That different signers were different people or places. People in the same home or office usually share an IP address.',
    'It is not a certificate-based digital signature like Adobe’s. PDF readers will not show a “signed” badge; integrity is checked with our Verify page, which relies on this service still running.',
    'Times come from our server clock, not an independent timestamp authority.',
    'We are not a party to your agreement and cannot say whether it is enforceable.',
  ]},
  {h: 'What that means for you', items: [
    'In the US, the ESIGN Act and state UETA laws generally treat electronic signatures as valid when there is intent to sign, consent to do business electronically, and a retained record. Many countries have similar laws. This tool records those three things.',
    'Some documents generally cannot be signed electronically under US law, or need more: wills, codicils and testamentary trusts; adoption, divorce and other family-law matters; court orders and official court documents; notices of utility shut-off, foreclosure or eviction from a primary home; cancellation of health or life insurance; product recalls; and documents that must be notarized or witnessed. Real estate recordings vary by state and county.',
    'For high-stakes agreements, or anything likely to be disputed, use an identity-verified e-signature service, or sign on paper with a notary.',
    `Download and keep the finished PDF. Our copy of the files is deleted after ${APP.docSpan}.`,
    'This is general information, not legal advice.',
  ]},
];

// Renders the sections into a container element.
function renderEsignInfo(el) {
  for (const s of ESIGN_INFO) {
    const h = document.createElement('h4'); h.textContent = s.h;
    const ul = document.createElement('ul');
    for (const t of s.items) { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); }
    el.append(h, ul);
  }
  return el;
}
