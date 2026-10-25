"""Discover every localized image/config path, including split atlas bundles."""
import re

def korean_path(path):
    return re.sub(r'(?<=_)jp(?=[_.])','en_kr',path.replace('/jp/','/en_kr/'))

def discover(jp,en):
    enpaths={a['assetPath']:a for a in en['assetInfos']}
    pairs={};matches=[];unmatched=[]
    for a in jp['assetInfos']:
        path=a['assetPath']
        if '/jp/' not in path or not path.lower().endswith(('.png','.jpg','.jpeg','_config.json')):continue
        other=korean_path(path)
        if other not in enpaths:
            unmatched.append(path);continue
        b=enpaths[other];key=(a['ownerBundleIndex'],b['ownerBundleIndex'])
        pairs.setdefault(key,(a,b))
        matches.append({'jp':path,'kr':other,'jpBundle':key[0],'krBundle':key[1]})
    return list(pairs.values()),{'matches':matches,'unmatched':unmatched,'bundlePairs':len(pairs),'scanned':len(matches)+len(unmatched)}
