import {
  BufferReader,
  BufferWriter,
  readUInt64LE,
  varuint,
  writeUInt64LE,
} from '../bufferutils';
import { decodeBip32Derivation, encodeBIP32Derivation } from './bip32';
import { OutputProprietaryTypes, OutputTypes } from './fields';
import {
  Bip32Derivation,
  TapBip32Derivation,
  TapInternalKey,
  TapLeaf,
  TapTree,
} from './interfaces';
import { ErrEmptyKey, Key, KeyPair } from './key_pair';
import { ProprietaryData } from './proprietary_data';
import { magicPrefix } from './pset';
import { isP2TR } from './utils';

export class OutputDuplicateFieldError extends Error {
  constructor(message?: string) {
    if (message) {
      message = 'Duplicated output ' + message;
    }
    super(message);
  }
}

export class PsetOutput {
  static fromBuffer(r: BufferReader): PsetOutput {
    let kp: KeyPair;
    const output = new PsetOutput();
    while (true) {
      try {
        kp = KeyPair.fromBuffer(r);
      } catch (e) {
        if (e instanceof Error && e === ErrEmptyKey) {
          output.sanityCheck();
          return output;
        }
        throw e;
      }

      switch (kp.key.keyType) {
        case OutputTypes.REDEEM_SCRIPT:
          if (output.redeemScript && output.redeemScript.length > 0) {
            throw new OutputDuplicateFieldError('redeem script');
          }
          output.redeemScript = kp.value;
          break;
        case OutputTypes.WITNESS_SCRIPT:
          if (output.witnessScript && output.witnessScript.length > 0) {
            throw new OutputDuplicateFieldError('witness script');
          }
          output.witnessScript = kp.value;
          break;
        case OutputTypes.BIP32_DERIVATION:
          const pubkey = kp.key.keyData;
          if (pubkey.length !== 33) {
            throw new Error('Invalid output bip32 pubkey length');
          }
          if (!output.bip32Derivation) {
            output.bip32Derivation = [];
          }
          if (output.bip32Derivation!.find((d) => d.pubkey.equals(pubkey))) {
            throw new OutputDuplicateFieldError('bip32 derivation');
          }
          const { masterFingerprint, path } = decodeBip32Derivation(kp.value);
          output.bip32Derivation!.push({ pubkey, masterFingerprint, path });
          break;
        case OutputTypes.AMOUNT:
          if (output.value > 0) {
            throw new OutputDuplicateFieldError('value');
          }
          if (kp.value.length !== 8) {
            throw new Error('Invalid output amount length');
          }
          output.value = readUInt64LE(kp.value, 0);
          break;
        case OutputTypes.SCRIPT:
          if (output.script && output.script.length > 0) {
            throw new OutputDuplicateFieldError('script');
          }
          output.script = kp.value;
          break;
        case OutputTypes.TAP_BIP32_DERIVATION:
          const tapKey = kp.key.keyData;
          if (tapKey!.length !== 33) {
            throw new Error('Invalid output bip32 derivation pubkey length');
          }
          if (!output.tapBip32Derivation) {
            output.tapBip32Derivation = [];
          }
          const tapBip32Pubkey = kp.key.keyData;
          if (
            output.tapBip32Derivation!.find((d) =>
              d.pubkey.equals(tapBip32Pubkey),
            )
          ) {
            throw new OutputDuplicateFieldError('taproot bip32 derivation');
          }
          const nHashes = varuint.decode(kp.value);
          const nHashesLen = varuint.encodingLength(nHashes);
          const bip32Deriv = decodeBip32Derivation(
            kp.value.slice(nHashesLen + nHashes * 32),
          );
          const leafHashes: Buffer[] = new Array(nHashes);
          for (let i = 0, _ofs = nHashesLen; i < nHashes; i++, _ofs += 32) {
            leafHashes[i] = kp.value.slice(_ofs, _ofs + 32);
          }
          output.tapBip32Derivation!.push({
            pubkey: tapBip32Pubkey,
            masterFingerprint: bip32Deriv.masterFingerprint,
            path: bip32Deriv.path,
            leafHashes,
          });
          break;
        case OutputTypes.TAP_TREE:
          if (output.tapTree!) {
            throw new OutputDuplicateFieldError('taproot tree');
          }
          let _offset = 0;
          const leaves: TapLeaf[] = [];
          while (_offset < kp.value.length) {
            const depth = kp.value[_offset++];
            const leafVersion = kp.value[_offset++];
            const scriptLen = varuint.decode(kp.value, _offset);
            _offset += varuint.encodingLength(scriptLen);
            leaves.push({
              depth,
              leafVersion,
              script: kp.value.slice(_offset, _offset + scriptLen),
            });
            _offset += scriptLen;
          }
          output.tapTree = { leaves };
          break;
        case OutputTypes.TAP_INTERNAL_KEY:
          if (output.tapInternalKey && output.tapInternalKey.length > 0) {
            throw new OutputDuplicateFieldError('taproot internal key');
          }
          if (kp.value.length !== 32) {
            throw new Error('Invalid output taproot internal key length');
          }
          output.tapInternalKey = kp.value;
          break;
        case OutputTypes.PROPRIETARY:
          const data = ProprietaryData.fromKeyPair(kp);
          if (Buffer.compare(data.identifier, magicPrefix) === 0) {
            switch (data.subType) {
              case OutputProprietaryTypes.VALUE_COMMITMENT:
                if (
                  output.valueCommitment &&
                  output.valueCommitment.length > 0
                ) {
                  throw new OutputDuplicateFieldError('value commitment');
                }
                if (kp.value.length !== 33) {
                  throw new Error('Invalid output value commitment length');
                }
                output.valueCommitment = kp.value;
                break;
              case OutputProprietaryTypes.ASSET:
                if (output.asset && output.asset.length > 0) {
                  throw new OutputDuplicateFieldError('asset');
                }
                if (kp.value.length !== 32) {
                  throw new Error('Invalid output asset length');
                }
                output.asset = kp.value;
                break;
              case OutputProprietaryTypes.ASSET_COMMITMENT:
                if (
                  output.assetCommitment &&
                  output.assetCommitment.length > 0
                ) {
                  throw new OutputDuplicateFieldError('asset commitment');
                }
                if (kp.value.length !== 33) {
                  throw new Error('Invalid output asset commitment length');
                }
                output.assetCommitment = kp.value;
                break;
              case OutputProprietaryTypes.VALUE_RANGEPROOF:
                if (
                  output.valueRangeproof &&
                  output.valueRangeproof.length > 0
                ) {
                  throw new OutputDuplicateFieldError('value range proof');
                }
                output.valueRangeproof = kp.value;
                break;
              case OutputProprietaryTypes.ASSET_SURJECTION_PROOF:
                if (
                  output.assetSurjectionProof &&
                  output.assetSurjectionProof.length > 0
                ) {
                  throw new OutputDuplicateFieldError('asset surjection proof');
                }
                output.assetSurjectionProof = kp.value;
                break;
              case OutputProprietaryTypes.BLINDING_PUBKEY:
                if (output.blindingPubkey && output.blindingPubkey.length > 0) {
                  throw new OutputDuplicateFieldError('blinding pubkey');
                }
                if (kp.value.length !== 33) {
                  throw new Error('Invalid output blinding pubkey length');
                }
                output.blindingPubkey = kp.value;
                break;
              case OutputProprietaryTypes.ECDH_PUBKEY:
                if (output.ecdhPubkey && output.ecdhPubkey.length > 0) {
                  throw new OutputDuplicateFieldError('ecdh pubkey');
                }
                if (kp.value.length !== 33) {
                  throw new Error('Invalid output ecdh pubkey length');
                }
                output.ecdhPubkey = kp.value;
                break;
              case OutputProprietaryTypes.BLINDER_INDEX:
                if (output.blinderIndex !== undefined) {
                  throw new OutputDuplicateFieldError('blinder index');
                }
                if (kp.value.length !== 4) {
                  throw new Error('Invalid output blinder index length');
                }
                output.blinderIndex = kp.value.readUInt32LE();
                break;
              case OutputProprietaryTypes.BLIND_VALUE_PROOF:
                if (
                  output.blindValueProof &&
                  output.blindValueProof.length > 0
                ) {
                  throw new OutputDuplicateFieldError('blind value proof');
                }
                output.blindValueProof = kp.value;
                break;
              case OutputProprietaryTypes.BLIND_ASSET_PROOF:
                if (
                  output.blindAssetProof &&
                  output.blindAssetProof.length > 0
                ) {
                  throw new OutputDuplicateFieldError('blind asset proof');
                }
                output.blindAssetProof = kp.value;
                break;
              default:
                if (!output.proprietaryData) {
                  output.proprietaryData = [];
                }
                output.proprietaryData!.push(data);
            }
          }
          break;
        default:
          if (!output.unknowns) {
            output.unknowns = [];
          }
          output.unknowns!.push(kp);
          break;
      }
    }
  }

  redeemScript?: Buffer;
  witnessScript?: Buffer;
  bip32Derivation?: Bip32Derivation[];
  value: number;
  script?: Buffer;
  tapBip32Derivation?: TapBip32Derivation[];
  tapTree?: TapTree;
  tapInternalKey?: TapInternalKey;
  valueCommitment?: Buffer;
  asset?: Buffer;
  assetCommitment?: Buffer;
  valueRangeproof?: Buffer;
  assetSurjectionProof?: Buffer;
  blindingPubkey?: Buffer;
  ecdhPubkey?: Buffer;
  blinderIndex?: number;
  blindValueProof?: Buffer;
  blindAssetProof?: Buffer;
  proprietaryData?: ProprietaryData[];
  unknowns?: KeyPair[];

  constructor(value?: number, asset?: Buffer, script?: Buffer) {
    this.value = value || 0;
    this.asset = asset || Buffer.from([]);
    this.script = script;
  }

  sanityCheck(): this {
    const valueCommitSet =
      this.valueCommitment && this.valueCommitment.length > 0;
    const blindValueProofSet =
      this.blindValueProof && this.blindValueProof.length > 0;
    if (this.value > 0 && valueCommitSet !== blindValueProofSet) {
      throw new Error('Missing output value commitment or blind proof');
    }
    const assetCommitSet =
      this.assetCommitment && this.assetCommitment.length > 0;
    const blindAssetProofSet =
      this.blindAssetProof && this.blindAssetProof.length > 0;
    if (!assetCommitSet && (!this.asset || this.asset.length === 0)) {
      throw new Error('Missing output asset');
    }
    if (
      this.asset &&
      this.asset.length > 0 &&
      assetCommitSet !== blindAssetProofSet
    ) {
      throw new Error('Missing output asset commitment or blind proof');
    }
    if (this.isPartiallyBlinded() && !this.isFullyBlinded()) {
      throw new Error(
        'Output is partially blinded while it must be either unblinded or fully blinded',
      );
    }
    if (this.isFullyBlinded() && this.blinderIndex! > 0) {
      throw new Error('Blinder index must be unset for fully blinded output');
    }

    return this;
  }

  needsBlinding(): boolean {
    return this.blindingPubkey! && this.blindingPubkey!.length > 0;
  }

  isPartiallyBlinded(): boolean {
    return (
      (this.valueCommitment! && this.valueCommitment!.length > 0) ||
      (this.assetCommitment! && this.assetCommitment!.length > 0) ||
      (this.valueRangeproof! && this.valueRangeproof!.length > 0) ||
      (this.assetSurjectionProof! && this.assetSurjectionProof!.length > 0) ||
      (this.ecdhPubkey! && this.ecdhPubkey!.length > 0)
    );
  }

  isFullyBlinded(): boolean {
    return (
      this.valueCommitment! &&
      this.valueCommitment!.length > 0 &&
      this.assetCommitment! &&
      this.assetCommitment!.length > 0 &&
      this.valueRangeproof! &&
      this.valueRangeproof!.length > 0 &&
      (this.assetSurjectionProof! && this.assetSurjectionProof!.length) > 0 &&
      this.ecdhPubkey! &&
      this.ecdhPubkey!.length > 0
    );
  }

  isTaproot(): boolean {
    return !!(
      this.tapInternalKey ||
      this.tapTree ||
      (this.tapBip32Derivation && this.tapBip32Derivation.length) ||
      (this.script && isP2TR(this.script))
    );
  }

  toBuffer(): Buffer {
    const keyPairs = this.getKeyPairs();
    const kpBuf = keyPairs.map((kp) => kp.toBuffer());
    let size = 0;
    kpBuf.forEach((buf) => {
      size += buf.length;
    });
    const w = BufferWriter.withCapacity(size);
    kpBuf.forEach((buf) => w.writeSlice(buf));
    return w.buffer;
  }

  private getKeyPairs(): KeyPair[] {
    const keyPairs = [] as KeyPair[];

    if (this.redeemScript! && this.redeemScript!.length > 0) {
      const key = new Key(OutputTypes.REDEEM_SCRIPT);
      keyPairs.push(new KeyPair(key, this.redeemScript!));
    }

    if (this.witnessScript! && this.witnessScript!.length > 0) {
      const key = new Key(OutputTypes.WITNESS_SCRIPT);
      keyPairs.push(new KeyPair(key, this.witnessScript!));
    }

    if (this.bip32Derivation! && this.bip32Derivation!.length > 0) {
      this.bip32Derivation!.forEach(({ pubkey, masterFingerprint, path }) => {
        const key = new Key(OutputTypes.BIP32_DERIVATION, pubkey);
        const value = encodeBIP32Derivation(masterFingerprint, path);
        keyPairs.push(new KeyPair(key, value));
      });
    }

    if (this.tapBip32Derivation! && this.tapBip32Derivation!.length > 0) {
      this.tapBip32Derivation!.forEach(
        ({ pubkey, masterFingerprint, path, leafHashes }) => {
          const key = new Key(OutputTypes.TAP_BIP32_DERIVATION, pubkey);
          const nHashesLen = varuint.encodingLength(leafHashes.length);
          const nHashesBuf = Buffer.allocUnsafe(nHashesLen);
          varuint.encode(leafHashes.length, nHashesBuf);
          const value = Buffer.concat([
            nHashesBuf,
            ...leafHashes,
            encodeBIP32Derivation(masterFingerprint, path),
          ]);
          keyPairs.push(new KeyPair(key, value));
        },
      );
    }

    if (this.tapTree!) {
      const key = new Key(OutputTypes.TAP_TREE);
      const bufs = ([] as Buffer[]).concat(
        ...this.tapTree.leaves.map((tapLeaf) => [
          Buffer.of(tapLeaf.depth, tapLeaf.leafVersion),
          varuint.encode(tapLeaf.script.length),
          tapLeaf.script,
        ]),
      );
      const value = Buffer.concat(bufs);
      keyPairs.push(new KeyPair(key, value));
    }

    if (this.tapInternalKey! && this.tapInternalKey!.length > 0) {
      const key = new Key(OutputTypes.TAP_INTERNAL_KEY);
      keyPairs.push(new KeyPair(key, this.tapInternalKey!));
    }

    const amountKey = new Key(OutputTypes.AMOUNT);
    const amount = Buffer.allocUnsafe(8);
    writeUInt64LE(amount, this.value, 0);
    keyPairs.push(new KeyPair(amountKey, amount));

    const scriptKey = new Key(OutputTypes.SCRIPT);
    keyPairs.push(new KeyPair(scriptKey, this.script || Buffer.alloc(0)));

    if (this.valueCommitment! && this.valueCommitment!.length > 0) {
      const keyData = ProprietaryData.proprietaryKey(
        OutputProprietaryTypes.VALUE_COMMITMENT,
      );
      const key = new Key(OutputTypes.PROPRIETARY, keyData);
      keyPairs.push(new KeyPair(key, this.valueCommitment!));
    }

    if (this.assetCommitment! && this.assetCommitment!.length > 0) {
      const keyData = ProprietaryData.proprietaryKey(
        OutputProprietaryTypes.ASSET_COMMITMENT,
      );
      const key = new Key(OutputTypes.PROPRIETARY, keyData);
      keyPairs.push(new KeyPair(key, this.assetCommitment!));
    }

    if (this.asset && this.asset.length > 0) {
      const keyData = ProprietaryData.proprietaryKey(
        OutputProprietaryTypes.ASSET,
      );
      const key = new Key(OutputTypes.PROPRIETARY, keyData);
      keyPairs.push(new KeyPair(key, this.asset));
    }

    if (this.valueRangeproof! && this.valueRangeproof!.length > 0) {
      const keyData = ProprietaryData.proprietaryKey(
        OutputProprietaryTypes.VALUE_RANGEPROOF,
      );
      const key = new Key(OutputTypes.PROPRIETARY, keyData);
      keyPairs.push(new KeyPair(key, this.valueRangeproof!));
    }

    if (this.assetSurjectionProof! && this.assetSurjectionProof!.length > 0) {
      const keyData = ProprietaryData.proprietaryKey(
        OutputProprietaryTypes.ASSET_SURJECTION_PROOF,
      );
      const key = new Key(OutputTypes.PROPRIETARY, keyData);
      keyPairs.push(new KeyPair(key, this.assetSurjectionProof!));
    }

    if (this.blindingPubkey! && this.blindingPubkey!.length > 0) {
      const keyData = ProprietaryData.proprietaryKey(
        OutputProprietaryTypes.BLINDING_PUBKEY,
      );
      const key = new Key(OutputTypes.PROPRIETARY, keyData);
      keyPairs.push(new KeyPair(key, this.blindingPubkey!));
    }

    if (this.ecdhPubkey! && this.ecdhPubkey!.length > 0) {
      const keyData = ProprietaryData.proprietaryKey(
        OutputProprietaryTypes.ECDH_PUBKEY,
      );
      const key = new Key(OutputTypes.PROPRIETARY, keyData);
      keyPairs.push(new KeyPair(key, this.ecdhPubkey!));
    }

    const proprietaryKeyData = ProprietaryData.proprietaryKey(
      OutputProprietaryTypes.BLINDER_INDEX,
    );
    const blinderIndexKey = new Key(
      OutputTypes.PROPRIETARY,
      proprietaryKeyData,
    );
    const blinderIndex = Buffer.allocUnsafe(4);
    let bi = 0;
    if (this.blinderIndex! > 0) {
      bi = this.blinderIndex!;
    }
    blinderIndex.writeUInt32LE(bi);
    keyPairs.push(new KeyPair(blinderIndexKey, blinderIndex));

    if (this.blindValueProof! && this.blindValueProof!.length > 0) {
      const keyData = ProprietaryData.proprietaryKey(
        OutputProprietaryTypes.BLIND_VALUE_PROOF,
      );
      const key = new Key(OutputTypes.PROPRIETARY, keyData);
      keyPairs.push(new KeyPair(key, this.blindValueProof!));
    }

    if (this.blindAssetProof! && this.blindAssetProof!.length > 0) {
      const keyData = ProprietaryData.proprietaryKey(
        OutputProprietaryTypes.BLIND_ASSET_PROOF,
      );
      const key = new Key(OutputTypes.PROPRIETARY, keyData);
      keyPairs.push(new KeyPair(key, this.blindAssetProof!));
    }

    if (this.proprietaryData! && this.proprietaryData!.length > 0) {
      this.proprietaryData.forEach((data) => {
        const keyData = ProprietaryData.proprietaryKey(
          data.subType,
          data.keyData,
        );
        const key = new Key(OutputTypes.PROPRIETARY, keyData);
        keyPairs.push(new KeyPair(key, data.value));
      });
    }

    keyPairs.concat(this.unknowns || []);

    return keyPairs;
  }
}
