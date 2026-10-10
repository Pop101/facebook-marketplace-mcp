import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeBase32, totp} from '../dist/utils/totp.js';

test('RFC 4648 base32 decodes authenticator secrets',()=>{
  assert.equal(decodeBase32('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').toString(), '12345678901234567890');
  assert.equal(decodeBase32('GEZD GN BV-GY3TQOJQGEZDGNBVGY3TQOJQ====').toString(), '12345678901234567890');
  assert.throws(()=>decodeBase32('NOT$BASE32'));
});
test('RFC 6238 SHA1 TOTP reference timestamps produce the expected 6-digit suffix',()=>{
  const secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totp(secret,59_000),'287082');
  assert.equal(totp(secret,1_111_111_109_000),'081804');
});
