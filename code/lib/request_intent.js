const HARD_NEGATIONS = [
  /not asking for deletion/i,
  /not a request to erase/i,
  /not a request to delete/i,
  /do not close the account/i,
  /don'?t close the account/i,
  /do not delete/i,
  /don'?t delete/i,
  /do not remove/i,
  /don'?t remove/i,
  /please don'?t delete or change anything/i,
  /without removing any of my records/i,
  /leave the account active/i,
  /keep the account as it is/i,
  /leave my profile and purchase history in place/i,
  /i still (?:need|use|want) the account/i,
  /i want to continue using the service/i,
  /i still want receipts/i,
  /this is an information request/i,
];

const DELETION_TERMS = [
  /delet/i,
  /eras/i,
  /erasure/i,
  /remov/i,
  /\bgone\b/i,
  /close (?:my|this|the) account/i,
  /clos(?:e|ed|ing) (?:it|my|this|the) account/i,
  /\bclosed\b/i,
  /purge/i,
  /permanently removed?/i,
  /profile is gone/i,
  /nothing .* point back to me/i,
  /elimina/i,
  /eliminaci[oó]n/i,
  /borrar/i,
  /borrado/i,
  /exclus[ãa]o/i,
  /excluir/i,
  /apagar/i,
  /deletar/i,
  /suprimir/i,
  /cerrar (?:mi|la) cuenta/i,
  /suppress?ion/i,
  /supprimer/i,
  /effacer/i,
  /l[oö]sch/i,
  /entfernen/i,
  /verwijder/i,
  /cancellare/i,
  /sopprimere/i,
  /삭제|해지|탈퇴|削除|消去|删除|刪除|注销/,
  /usuni[eę]/i,
  /usu[nń]/i,
  /удал/i,
  /حذف/,
  /sil(?:me|mek)/i,
  /hapus/i,
];

const NON_DELETION_ACTIONS = [
  [/(?:mobile )?number .* out of date|replace it with the new one/i, 'correction'],
  [/surname is misspelled|can you correct it/i, 'correction'],
  [/change the email address/i, 'correction'],
  [/reset(?:ting)? the login|can'?t access my profile/i, 'access_help'],
  [/stop the promotional emails|remove me from marketing lists/i, 'marketing_opt_out'],
  [
    /download my account information|send me a copy of the information|copy of last year'?s invoices|what personal information you hold/i,
    'access',
  ],
];

function classifyIntent(rawText) {
  const body = String(rawText || '').trim();
  const result = {
    is_deletion: false,
    label: 'unclear',
    matched_terms: [],
    matched_negations: [],
    non_deletion_action: '',
  };
  if (!body) return result;

  const negations = HARD_NEGATIONS.filter((re) => re.test(body)).map((re) => re.source);
  if (negations.length) {
    result.label = 'not_deletion';
    result.matched_negations = negations;
    return result;
  }

  const terms = DELETION_TERMS.filter((re) => re.test(body)).map((re) => re.source);
  const action = NON_DELETION_ACTIONS.find(([re]) => re.test(body));
  result.non_deletion_action = action ? action[1] : '';
  if (terms.length) {
    result.is_deletion = true;
    result.label = 'deletion';
    result.matched_terms = terms;
    return result;
  }
  if (action) {
    result.label = 'not_deletion';
    return result;
  }
  return result;
}

export { classifyIntent };
