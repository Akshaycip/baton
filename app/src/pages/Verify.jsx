import { Link, useParams } from 'react-router-dom';
import { accountInfo, collection, view } from '../api.js';
import { near, shortName } from '../format.js';
import { useLive } from '../hooks.js';

function Check({ pass, title, body, command }) {
  return (
    <li className={`check ${pass ? 'pass' : 'fail'}`}>
      <span className="mark" aria-label={pass ? 'Passed' : 'Failed'}>{pass ? '✓' : '✕'}</span>
      <div>
        <h3>{title}</h3>
        <p>{body}</p>
        {command && <code className="mono">{command}</code>}
      </div>
    </li>
  );
}

export function Verify() {
  const { token } = useParams();
  const { data, error } = useLive(async () => {
    const col = collection();
    const [vault, item, nft, baton, info, cfg, epoch, colAccount] = await Promise.all([
      accountInfo(token),
      view(token, 'nft_item_info'),
      view(col, 'nft_token', { token_id: token }),
      view(col, 'baton_get', { token_id: token }),
      view(token, 'vault_info'),
      view(col, 'baton_config'),
      view(col, 'config_epoch'),
      accountInfo(col),
    ]);
    const pool = await view(info.pool_id, 'get_account', { account_id: token });
    return { vault, item, nft, baton, info, cfg, epoch, colAccount, pool };
  }, [token], 8000);

  if (error && !data) return <p className="error">Could not reach the chain. {error.message}</p>;
  if (!data) return <p className="empty">Reading the chain…</p>;

  const { vault, item, nft, baton, info, cfg, colAccount, pool } = data;
  const net = 'network-config testnet';
  const col = collection();
  const label = info.pool_id.slice(0, -cfg.pool_suffix.length);
  const official = info.pool_id.endsWith(cfg.pool_suffix) && !label.includes('.');
  const sameOwner = item.owner_id === nft.owner_id;
  const sameSeq = item.rotation_seq === baton.baton.rotation_seq;

  return (
    <section className="narrow">
      <p className="eyebrow mono">{token}</p>
      <h1>Check it yourself</h1>
      <p className="lede">Each line below is read live from the chain, and the commands let you repeat every check yourself.</p>

      <ol className="checks">
        <Check
          pass={vault.exists && vault.keys === 0}
          title="Nobody holds a key to this account"
          body={`This account has ${vault.keys} access keys, so nothing can sign for it. The seller has no way back in.`}
          command={`near account list-keys ${token} ${net} now`}
        />
        <Check
          pass={vault.codeHash === cfg.vault_code_hash}
          title="It runs the published vault code"
          body={`Code hash ${vault.codeHash}. The code is fixed by its hash and cannot be swapped.`}
          command={`near account view-account-summary ${token} ${net} now`}
        />
        <Check
          pass={BigInt(pool.staked_balance) + BigInt(pool.unstaked_balance) > 0n || BigInt(baton.baton.liquid) > 0n}
          title="The stake is really at the validator"
          body={`${shortName(info.pool_id)} reports ${near(pool.staked_balance, 3)} NEAR staked and ${near(pool.unstaked_balance, 3)} NEAR unstaking for this account.`}
          command={`near contract call-function as-read-only ${info.pool_id} get_account json-args '{"account_id":"${token}"}' ${net} now`}
        />
        <Check
          pass={official}
          title="The validator is an official staking pool"
          body={`${info.pool_id} is a sub-account of the official factory. Only the factory can create those names.`}
        />
        <Check
          pass={sameOwner && sameSeq}
          title="The account and the NFT agree on the holder"
          body={`Both say ${nft.owner_id}, at change number ${item.rotation_seq}. This is the pair check from the Sharded NFT Items draft.`}
          command={`near contract call-function as-read-only ${token} nft_item_info json-args '{}' ${net} now`}
        />
        <Check
          pass={colAccount.keys === 0}
          title="Nobody can change the rules"
          body={colAccount.keys === 0 ? 'The collection contract has no access keys, so it cannot be upgraded. It also has no admin methods.' : `The collection still has ${colAccount.keys} access key(s), so its deployer could still change it. Keys are removed when a deployment is finished.`}
          command={`near account list-keys ${col} ${net} now`}
        />
      </ol>
      <p><Link to={`/b/${token}`}>Back to this Baton</Link></p>
    </section>
  );
}
